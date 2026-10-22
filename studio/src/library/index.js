import { randomUUID } from 'node:crypto';
import { canonicalDigest, canonicalJSON } from '../engine/contracts.js';
import { originKey, validateOriginRef, validateBundle } from '../reuse/bundle.js';
import { openRegistry, clone, fields, text, projects, invalid, transaction, revision, checkRevision, bump, owner, requireOwner, replay, saveReceipt, safeError, adapterError } from './registry.js';
import { portable, scopedRef, validateProjection, snapshot, replaceProjection } from './projection.js';
import { queryLibrary } from './query.js';

function envelope(input) {
  const value = clone(input);
  fields(value, ['commandId', 'expectedRegistryRevision', 'type', 'payload']);
  text(value.commandId);
  if (!Number.isSafeInteger(value.expectedRegistryRevision) || value.expectedRegistryRevision < 0) invalid();
  const payload = value.payload;
  switch (value.type) {
    case 'owner.register':
      fields(payload, ['adapterKind', 'locator', 'allowedProjects']); text(payload.adapterKind); projects(payload.allowedProjects);
      if (!payload.locator || !['string', 'object'].includes(typeof payload.locator) || Array.isArray(payload.locator)) invalid();
      break;
    case 'owner.rebind':
      fields(payload, ['ownerId', 'locator', 'confirmRefs'], ['allowedProjects']); text(payload.ownerId);
      if (payload.allowedProjects !== undefined) projects(payload.allowedProjects);
      if (!payload.locator || !['string', 'object'].includes(typeof payload.locator) || Array.isArray(payload.locator) || !Array.isArray(payload.confirmRefs) || payload.confirmRefs.length === 0) invalid();
      payload.confirmRefs.forEach(validateOriginRef); break;
    case 'owner.unregister': case 'owner.refresh': fields(payload, ['ownerId']); text(payload.ownerId); break;
    default: invalid();
  }
  return value;
}
export async function openLibrary({ directory, adapters = {} }) {
  const db = await openRegistry(directory);
  const pending = new Set(); const commands = new Map(); let closing = null;
  function admitted(work, input, parse) {
    if (closing) return Promise.reject(safeError('LIBRARY_CLOSED'));
    let request;
    try { request = parse(input); } catch (error) { return Promise.reject(error); }
    const promise = Promise.resolve().then(() => work(request)); pending.add(promise);
    promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise;
  }
  async function adapterFor(registration) {
    const factory = Object.hasOwn(adapters, registration.adapterKind) ? adapters[registration.adapterKind] : null;
    if (typeof factory !== 'function') throw safeError('ADAPTER_UNAVAILABLE');
    try {
      const adapter = await factory({ locator: clone(registration.locator), ownerId: registration.ownerId, allowedProjects: [...registration.allowedProjects] });
      if (!adapter || typeof adapter.identify !== 'function' || typeof adapter.capture !== 'function' || typeof adapter.exportExact !== 'function') throw safeError('OWNER_OFFLINE');
      return adapter;
    } catch (error) { throw adapterError(error); }
  }
  async function identify(adapter) {
    try { const fingerprint = await adapter.identify(); text(fingerprint); return fingerprint; }
    catch (error) { throw adapterError(error); }
  }
  async function checkIdentity(adapter, registration) {
    if (await identify(adapter) !== registration.sourceFingerprint) throw safeError('OWNER_REPLACED');
  }
  function same(registration, sequence = false) {
    const current = owner(db, registration.ownerId);
    return current && current.generation === registration.generation && (!sequence || current.sequence === registration.sequence);
  }
  function receipt(command, extra) { return { commandId: command.commandId, registryRevision: revision(db), ...extra }; }
  async function execute(command, digest) {
    const existing = transaction(db, () => replay(db, command, digest), false);
    if (existing?.receipt) return existing.receipt;
    if (command.type === 'owner.refresh') return refresh(command, digest);
    if (command.type === 'owner.unregister') return transaction(db, () => {
      const existing = replay(db, command, digest); if (existing?.receipt) return existing.receipt;
      checkRevision(db, command.expectedRegistryRevision); const registration = requireOwner(db, command.payload.ownerId);
      db.prepare('DELETE FROM owners WHERE owner_id=?').run(registration.ownerId);
      db.prepare('DELETE FROM projection.snapshots WHERE owner_id=?').run(registration.ownerId); bump(db);
      return saveReceipt(db, command, digest, receipt(command, { ownerId: registration.ownerId, status: 'unregistered' }));
    });
    const registration = transaction(db, () => {
      checkRevision(db, command.expectedRegistryRevision);
      if (command.type === 'owner.register') return { ...command.payload, ownerId: randomUUID(), generation: 1 };
      const current = requireOwner(db, command.payload.ownerId);
      const rebound = { ...current, locator: command.payload.locator, allowedProjects: command.payload.allowedProjects ?? current.allowedProjects };
      command.payload.confirmRefs.forEach(ref => scopedRef(ref, rebound));
      return rebound;
    }, false);
    const adapter = await adapterFor(registration); const fingerprint = await identify(adapter);
    if (command.type === 'owner.rebind') {
      if (typeof adapter.verifyRefs !== 'function') throw safeError('OWNER_REBIND_UNCONFIRMED');
      let verified;
      try { verified = await adapter.verifyRefs(clone(command.payload.confirmRefs)); } catch (error) { throw adapterError(error); }
      if (verified !== true) throw safeError('OWNER_REBIND_UNCONFIRMED');
      if (await identify(adapter) !== fingerprint) throw safeError('OWNER_REPLACED');
    }
    return transaction(db, () => {
      const existing = replay(db, command, digest); if (existing?.receipt) return existing.receipt;
      checkRevision(db, command.expectedRegistryRevision);
      if (command.type === 'owner.register') {
        db.prepare('INSERT INTO owners(owner_id,adapter_kind,locator_json,allowed_json,generation,source_fingerprint,status) VALUES (?,?,?,?,?,?,?)').run(registration.ownerId, registration.adapterKind, canonicalJSON(registration.locator), canonicalJSON(registration.allowedProjects), 1, fingerprint, 'unverified');
      } else {
        if (!same(registration)) throw safeError('OWNER_CHANGED');
        db.prepare("UPDATE owners SET locator_json=?, allowed_json=?, source_fingerprint=?, generation=generation+1, request_sequence=request_sequence+1, status='unverified', error_code=NULL WHERE owner_id=?").run(canonicalJSON(registration.locator), canonicalJSON(registration.allowedProjects), fingerprint, registration.ownerId);
      }
      bump(db);
      return saveReceipt(db, command, digest, receipt(command, { ownerId: registration.ownerId, generation: command.type === 'owner.register' ? 1 : registration.generation + 1, status: 'unverified' }));
    });
  }
  async function refresh(command, digest) {
    const admission = transaction(db, () => {
      const existing = replay(db, command, digest); if (existing?.receipt) return { receipt: existing.receipt };
      if (existing?.context) {
        const registration = owner(db, existing.context.ownerId);
        return { registration: registration && registration.generation === existing.context.generation && registration.sequence === existing.context.sequence ? registration : null };
      }
      checkRevision(db, command.expectedRegistryRevision); const registration = requireOwner(db, command.payload.ownerId);
      db.prepare('UPDATE owners SET request_sequence=request_sequence+1 WHERE owner_id=?').run(registration.ownerId);
      registration.sequence++;
      db.prepare('INSERT INTO commands(command_id,digest,context_json) VALUES (?,?,?)').run(command.commandId, digest, canonicalJSON({ ownerId: registration.ownerId, generation: registration.generation, sequence: registration.sequence }));
      return { registration };
    });
    if (admission.receipt) return admission.receipt;
    const registration = admission.registration;
    let projection; let error;
    if (registration) try {
      const adapter = await adapterFor(registration); await checkIdentity(adapter, registration);
      const previous = snapshot(db, registration.ownerId);
      const value = await adapter.capture({ ownerId: registration.ownerId, allowedProjects: [...registration.allowedProjects], ...(previous && previous.observed.registrationGeneration === registration.generation ? { afterToken: previous.token } : {}) });
      await checkIdentity(adapter, registration);
      projection = validateProjection(value, registration);
    } catch (failure) { error = adapterError(failure); }
    return transaction(db, () => {
      const existing = replay(db, command, digest); if (existing?.receipt) return existing.receipt;
      let result;
      if (!registration || !same(registration, true)) result = receipt(command, { ownerId: command.payload.ownerId, status: 'discarded' });
      else if (error) {
        const status = error.code === 'OWNER_REPLACED' ? 'replaced' : 'offline';
        db.prepare('UPDATE owners SET status=?,error_code=? WHERE owner_id=?').run(status, error.code, registration.ownerId);
        result = receipt(command, { ownerId: registration.ownerId, status, error: { code: error.code } });
      } else {
        replaceProjection(db, registration, projection, new Date().toISOString());
        db.prepare("UPDATE owners SET status='observed-available',error_code=NULL WHERE owner_id=?").run(registration.ownerId);
        result = receipt(command, { ownerId: registration.ownerId, status: 'observed-available', observed: snapshot(db, registration.ownerId).observed });
      }
      return saveReceipt(db, command, digest, result);
    });
  }
  async function exportExact(input) {
    const request = portable(input); fields(request, ['ownerId', 'roots', 'disclosure']); text(request.ownerId);
    if (!Array.isArray(request.roots) || request.roots.length === 0) invalid();
    const registration = transaction(db, () => requireOwner(db, request.ownerId), false);
    for (const value of request.roots) {
      const ref = validateOriginRef(value);
      if (ref.ownerId !== registration.ownerId) throw safeError('OWNER_SCOPE_MISMATCH');
      if (!registration.allowedProjects.includes(ref.projectId)) throw safeError('PROJECT_NOT_ALLOWED');
    }
    const adapter = await adapterFor(registration); let output;
    try { await checkIdentity(adapter, registration); output = await adapter.exportExact(clone({ roots: request.roots, disclosure: request.disclosure })); await checkIdentity(adapter, registration); }
    catch (failure) {
      const error = adapterError(failure);
      transaction(db, () => { if (same(registration, true)) db.prepare('UPDATE owners SET status=?,error_code=? WHERE owner_id=?').run(error.code === 'OWNER_REPLACED' ? 'replaced' : 'offline', error.code, registration.ownerId); });
      throw error;
    }
    return transaction(db, () => {
      if (!same(registration)) throw safeError('OWNER_CHANGED');
      fields(output, ['bundle', 'bytes']);
      const bundle = validateBundle(output.bundle, output.bytes); portable(bundle, registration);
      if (canonicalJSON(bundle.roots.map(originKey).sort()) !== canonicalJSON(request.roots.map(originKey).sort())) throw safeError('BUNDLE_INCOMPLETE');
      for (const record of bundle.records) {
        if (record.ref.ownerId === registration.ownerId && !registration.allowedProjects.includes(record.ref.projectId)) throw safeError('PROJECT_NOT_ALLOWED');
      }
      return { bundle, bytes: clone(output.bytes) };
    }, false);
  }
  return {
    command(input) {
      return admitted(command => {
        const digest = canonicalDigest(command); const existing = commands.get(command.commandId);
        if (existing) { if (existing.digest !== digest) throw safeError('COMMAND_CONFLICT'); return existing.promise; }
        const promise = execute(command, digest); commands.set(command.commandId, { digest, promise });
        promise.then(() => commands.delete(command.commandId), () => commands.delete(command.commandId)); return promise;
      }, input, envelope);
    },
    query: request => admitted(request => queryLibrary(db, request), request, portable),
    exportExact: request => admitted(request => exportExact(request), request, portable),
    close() {
      if (!closing) closing = (async () => { await Promise.allSettled([...pending]); db.close(); })();
      return closing;
    }
  };
}
