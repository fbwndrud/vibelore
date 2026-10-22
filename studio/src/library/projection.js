import { isPrivatePortableKey } from "../engine/portable.js";
import { validateEntryFilters } from "./entry-fields.js";
import { isProxy } from 'node:util/types';
import { canonicalJSON } from '../engine/contracts.js';
import { validateOriginRef, originKey } from '../reuse/bundle.js';
import { fields, invalid, text, clone } from './registry.js';

const MEDIA = ['text', 'image', 'audio', 'video', 'structured'];
const AVAILABILITY = ['unverified', 'observed-available', 'offline', 'missing', 'corrupt'];
const CAPABILITIES = ['discover', 'preserve', 'inspect', 'derive', 'render'];
const RELATIONS = ['derived-from', 'normalized-from', 'adapted-from', 'used-in', 'observed-in'];

// Projection payloads may include literal prompts and observations. They remain
// plain data, with private connection fields and accessor/proxy execution denied.
// Every locator string is a private binding, not a public semantic option. Keep
// project/work selections in allowedProjects instead of exempting locator data.
export function portable(value, registration) {
  const secrets = [];
  function collect(value) {
    if (typeof value === 'string' && value.length > 0) secrets.push(value);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  }
  if (registration) { collect(registration.locator); secrets.push(registration.sourceFingerprint); }
  const seen = new Set();
  function visit(value, depth) {
    if (typeof value === 'string') {
      if (secrets.some(secret => secret && value.includes(secret))) invalid();
      return;
    }
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
    if (!value || typeof value !== 'object' || isProxy(value) || seen.has(value) || depth > 32) invalid();
    const proto = Object.getPrototypeOf(value); const array = Array.isArray(value);
    if (array ? proto !== Array.prototype : ![Object.prototype, null].includes(proto)) invalid();
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || (isPrivatePortableKey(key) && !(depth === 1 && key === 'token')) || !('value' in descriptor)) invalid();
      if (!array) visit(key, depth + 1);
      if (!(array && key === 'length')) visit(descriptor.value, depth + 1);
    }
    seen.delete(value);
  }
  visit(value, 1); return clone(value);
}
export function scopedRef(value, registration) {
  const ref = validateOriginRef(value);
  if (ref.ownerId !== registration.ownerId) invalid();
  if (!registration.allowedProjects.includes(ref.projectId)) invalid();
  return ref;
}
function array(value) { if (!Array.isArray(value)) invalid(); }
function strings(value, allowed) { array(value); value.forEach(item => { text(item); if (allowed && !allowed.includes(item)) invalid(); }); }
function subject(value) {
  fields(value, ['ownerId', 'projectId', 'identityId', 'stateRefs'], ['continuityId']);
  text(value.ownerId); text(value.projectId); text(value.identityId); if (value.continuityId !== undefined) text(value.continuityId);
  array(value.stateRefs); value.stateRefs.forEach(validateOriginRef);
}
export function validateProjection(value, registration) {
  value = portable(value, registration);
  fields(value, ['token', 'entries', 'links', 'uses', 'cases']); text(value.token);
  for (const key of ['entries', 'links', 'uses', 'cases']) array(value[key]);
  const keys = new Set();
  for (const entry of value.entries) {
    fields(entry, ['ref', 'title', 'mediaKind', 'roles', 'subjects', 'expressionRefs', 'availability', 'capabilities'], ['status', 'reviewStatus', 'adoptionStatus', 'sourceType']);
    scopedRef(entry.ref, registration); text(entry.title);
    if (!MEDIA.includes(entry.mediaKind) || !AVAILABILITY.includes(entry.availability)) invalid();
    validateEntryFilters(entry);
    strings(entry.roles); strings(entry.capabilities, CAPABILITIES);
    array(entry.subjects); entry.subjects.forEach(subject);
    array(entry.expressionRefs); entry.expressionRefs.forEach(validateOriginRef);
    const key = originKey(entry.ref); if (keys.has(key)) invalid(); keys.add(key);
  }
  for (const link of value.links) {
    fields(link, ['from', 'relation', 'to', 'requirement']); validateOriginRef(link.from); validateOriginRef(link.to);
    if (!RELATIONS.includes(link.relation) || !['runtime', 'historical-reference'].includes(link.requirement)) invalid();
    scopedRef(['used-in', 'observed-in'].includes(link.relation) ? link.to : link.from, registration);
  }
  for (const use of value.uses) {
    fields(use, ['ref', 'usedIn'], ['role', 'purpose', 'receiptRef']); validateOriginRef(use.ref); scopedRef(use.usedIn, registration);
    if (use.receiptRef) scopedRef(use.receiptRef, registration);
    for (const key of ['role', 'purpose']) if (use[key] !== undefined) text(use[key]);
  }
  for (const item of value.cases) {
    fields(item, ['id', 'ownerId', 'projectId', 'question', 'contextRefs', 'literalInputRefs', 'trials', 'observations', 'unknowns'], ['decision', 'ref', 'classification', 'literalInputs', 'omissions', 'planning', 'externalObservations', 'evaluationVerification']);
    text(item.id); text(item.question);
    if (item.evaluationVerification !== undefined && item.evaluationVerification !== "not_performed") invalid();
    if (item.ref !== undefined) { scopedRef(item.ref, registration); if (item.ref.projectId !== item.projectId) invalid(); }
    if (item.classification !== undefined && !['accepted-example', 'matched-comparison', 'failed-trial', 'unobserved'].includes(item.classification)) invalid();
    if (item.ownerId !== registration.ownerId || !registration.allowedProjects.includes(item.projectId)) invalid();
    for (const key of ['contextRefs', 'literalInputRefs']) { array(item[key]); item[key].forEach(validateOriginRef); }
    for (const key of ['trials', 'observations', 'unknowns']) array(item[key]);
  }
  return value;
}
export function localAnchorAllowed(ref, registration) {
  return ref.ownerId === registration.ownerId && registration.allowedProjects.includes(ref.projectId);
}
export function linkAnchor(link) { return ['used-in', 'observed-in'].includes(link.relation) ? link.to : link.from; }
export function snapshot(db, ownerId) {
  const row = db.prepare('SELECT value_json FROM projection.snapshots WHERE owner_id=?').get(ownerId);
  return row ? JSON.parse(row.value_json) : null;
}
export function replaceProjection(db, registration, projection, at) {
  const old = snapshot(db, registration.ownerId);
  const observed = { token: projection.token, at, registrationGeneration: registration.generation };
  const entries = projection.entries.map(entry => ({ ...entry, observed }));
  const keys = new Set(entries.map(entry => originKey(entry.ref)));
  // A successful complete capture confirms absent exact revisions as missing,
  // while retaining their old observation and their immutable provenance refs.
  for (const entry of old?.entries ?? []) if (!keys.has(originKey(entry.ref))) entries.push(localAnchorAllowed(entry.ref, registration) ? { ...entry, availability: 'missing' } : entry);
  // Scope changes do not erase previously authorized private history. Only
  // currently allowed anchors are exposed by queries or read from the source.
  const links = [...projection.links, ...(old?.links ?? []).filter(link => !localAnchorAllowed(linkAnchor(link), registration))];
  const uses = [...projection.uses, ...(old?.uses ?? []).filter(use => !localAnchorAllowed(use.usedIn, registration))];
  const cases = [...projection.cases, ...(old?.cases ?? []).filter(item => !registration.allowedProjects.includes(item.projectId))];
  const value = { ...projection, entries, links, uses, cases, observed };
  db.prepare('INSERT INTO projection.snapshots VALUES (?,?) ON CONFLICT(owner_id) DO UPDATE SET value_json=excluded.value_json').run(registration.ownerId, canonicalJSON(value));
}
export function entryView(entry, registration) {
  const availability = registration.status === 'replaced' || entry.observed.registrationGeneration !== registration.generation
    ? 'unverified' : registration.status === 'offline' ? 'offline' : entry.availability;
  return { status: 'unknown', reviewStatus: 'unknown', adoptionStatus: 'unknown', sourceType: 'unknown', ...entry, availability };
}
export function ownerView(registration, projection) {
  return { ownerId: registration.ownerId, adapterKind: registration.adapterKind, allowedProjects: registration.allowedProjects, generation: registration.generation, status: registration.status,
    ...(registration.errorCode ? { error: { code: registration.errorCode } } : {}), ...(projection?.observed ? { observed: projection.observed } : {}) };
}
