import { originKey, validateOriginRef } from '../reuse/bundle.js';
import { allOwners, owner, revision, fields, invalid, text, transaction } from './registry.js';
import { portable, snapshot, ownerView, entryView, localAnchorAllowed, linkAnchor } from './projection.js';

export function queryLibrary(db, input) {
  const request = portable(input);
  text(request?.type);
  if (request.type === 'find') {
    fields(request, ['type'], ['text', 'mediaKind', 'ownerId', 'projectId', 'role', 'subject', 'limit']);
    for (const key of ['text', 'ownerId', 'projectId', 'role']) if (request[key] !== undefined) text(request[key]);
    if (request.mediaKind !== undefined && !['text', 'image', 'audio', 'video', 'structured'].includes(request.mediaKind)) invalid();
    if (request.limit !== undefined && (!Number.isSafeInteger(request.limit) || request.limit < 1)) invalid();
    if (request.subject !== undefined) {
      fields(request.subject, ['ownerId', 'projectId', 'identityId'], ['continuityId']); Object.values(request.subject).forEach(text);
    }
  } else if (['inspect', 'lineage', 'uses'].includes(request.type)) {
    fields(request, ['type', 'ref']); validateOriginRef(request.ref);
  } else if (request.type === 'cases') {
    fields(request, ['type'], ['ownerId', 'projectId']);
    for (const key of ['ownerId', 'projectId']) if (request[key] !== undefined) text(request[key]);
  } else invalid();
  return transaction(db, () => {
    const registryRevision = revision(db);
    if (['inspect', 'lineage', 'uses'].includes(request.type)) {
      const registration = owner(db, request.ref.ownerId); const projection = registration ? snapshot(db, registration.ownerId) : null;
      const base = { registryRevision, owners: registration ? [ownerView(registration, projection)] : [] };
      const key = originKey(request.ref);
      if (request.type === 'inspect') {
        if (registration && !registration.allowedProjects.includes(request.ref.projectId)) return { ...base, status: 'unverified', entry: null };
        const stored = projection?.entries.find(entry => originKey(entry.ref) === key);
        const entry = stored ? entryView(stored, registration) : null;
        const currentObservation = projection && projection.observed.registrationGeneration === registration?.generation;
        const status = entry?.availability ?? (!registration ? 'unregistered' : registration.status === 'offline' ? 'offline' : registration.status === 'replaced' || !currentObservation ? 'unverified' : 'missing');
        return { ...base, status, entry };
      }
      const observations = []; const owners = [];
      for (const local of allOwners(db)) {
        const captured = snapshot(db, local.ownerId);
        const matches = request.type === 'lineage'
          ? captured?.links.filter(link => localAnchorAllowed(linkAnchor(link), local) && (originKey(link.from) === key || originKey(link.to) === key)) ?? []
          : captured?.uses.filter(use => localAnchorAllowed(use.usedIn, local) && originKey(use.ref) === key) ?? [];
        if (matches.length) { owners.push(ownerView(local, captured)); observations.push(...matches); }
      }
      return request.type === 'lineage' ? { registryRevision, owners, links: observations } : { registryRevision, owners, uses: observations };
    }
    const registrations = allOwners(db).filter(value => (!request.ownerId || value.ownerId === request.ownerId) && (!request.projectId || value.allowedProjects.includes(request.projectId)));
    const owners = []; const values = [];
    for (const registration of registrations) {
      const projection = snapshot(db, registration.ownerId); owners.push(ownerView(registration, projection));
      if (request.type === 'cases') values.push(...(projection?.cases ?? []).filter(item => registration.allowedProjects.includes(item.projectId) && (!request.projectId || item.projectId === request.projectId)));
      else for (const stored of projection?.entries ?? []) {
        if (!localAnchorAllowed(stored.ref, registration)) continue;
        const entry = entryView(stored, registration);
        if (request.text && !entry.title.toLocaleLowerCase().includes(request.text.toLocaleLowerCase())) continue;
        if (request.mediaKind && entry.mediaKind !== request.mediaKind) continue;
        if (request.projectId && entry.ref.projectId !== request.projectId) continue;
        if (request.role && !entry.roles.includes(request.role)) continue;
        if (request.subject && !entry.subjects.some(subject => Object.entries(request.subject).every(([key, value]) => subject[key] === value))) continue;
        values.push(entry);
      }
    }
    return request.type === 'cases' ? { registryRevision, owners, cases: values } : { registryRevision, owners, entries: values.slice(0, request.limit) };
  }, false);
}
