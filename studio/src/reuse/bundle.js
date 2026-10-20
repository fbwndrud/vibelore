import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { isProxy } from 'node:util/types';
import { lstat, open, mkdir, rm } from 'node:fs/promises';
import { resolve, parse, join, dirname } from 'node:path';
import { canonicalJSON, canonicalDigest, fail, publicError } from '../engine/contracts.js';

const MANIFEST_LIMIT = 512 * 1024;
const FILE_LIMIT = 20 * 1024 * 1024;
const TOTAL_LIMIT = 24 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const PRIVATE_OR_ACTIVE_KEYS = new Set([
  'path', 'filePath', 'rootDir', 'sourcePath', 'worldRoot', 'directory',
  'absolutePath', 'locator', 'executableInstruction', 'fetchInstruction'
]);
const REF_KEYS = ['ownerId', 'projectId', 'recordKind', 'recordId', 'revision'];
const RECORD_KEYS = ['ref', 'recordSha256', 'metadata', 'requiredFileSha256s', 'sourcePins', 'evidenceRefs'];
const MANIFEST_KEYS = ['schemaVersion', 'manifestSha256', 'roots', 'records', 'files', 'links', 'disclosure', 'capturedAt'];
const RELATIONS = new Set(['derived-from', 'normalized-from', 'adapted-from', 'used-in', 'observed-in']);
const invalid = () => fail('INVALID_INPUT', 'Expected a safe portable bundle value.');
const incomplete = () => fail('BUNDLE_INCOMPLETE', 'Required bundle records or bytes are missing or incomplete.');
function exceeded(limit) { fail('BUNDLE_LIMIT_EXCEEDED', 'The bundle exceeds a supported limit.', { limit }); }
function object(value) { if (value === null || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) invalid(); }
function array(value) { if (!Array.isArray(value)) invalid(); }
function text(value) { if (typeof value !== 'string' || !value.trim()) invalid(); }
function sha(value) { if (typeof value !== 'string' || !SHA256.test(value)) invalid(); }
function fields(value, allowed, optional = []) {
  object(value);
  if (Object.keys(value).some(key => !allowed.includes(key)) || allowed.some(key => !optional.includes(key) && !Object.hasOwn(value, key))) invalid();
}

// Check descriptors before reading values: even validation must never invoke getters.
// Depth is the number of object/array containers, with the root at depth one.
function portable(value) {
  const seen = new Set();
  function visit(input, depth) {
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return;
    if (typeof input === 'number' && Number.isFinite(input)) return;
    if (typeof input !== 'object' || isProxy(input) || seen.has(input)) invalid();
    if (depth > 32) exceeded('jsonDepth');
    const isArray = Array.isArray(input);
    const prototype = Object.getPrototypeOf(input);
    if (!isArray && prototype !== Object.prototype && prototype !== null) invalid();
    if (isArray && prototype !== Array.prototype) invalid();
    seen.add(input);
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(descriptors);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key)
        || PRIVATE_OR_ACTIVE_KEYS.has(key) || !('value' in descriptor)
        || (!descriptor.enumerable && !(isArray && key === 'length'))) invalid();
    }
    if (isArray) {
      const length = descriptors.length.value;
      if (keys.length !== length + 1) invalid();
      for (let index = 0; index < length; index++) {
        if (!Object.hasOwn(descriptors, index)) invalid();
        visit(descriptors[index].value, depth + 1);
      }
    } else {
      for (const key of keys) visit(descriptors[key].value, depth + 1);
    }
    seen.delete(input);
  }
  visit(value, 1);
  const json = canonicalJSON(value);
  if (Buffer.byteLength(json) > MANIFEST_LIMIT) exceeded('manifestBytes');
  return JSON.parse(json);
}
function checkRef(value) {
  fields(value, REF_KEYS);
  for (const key of REF_KEYS) text(value[key]);
  if (value.revision.trim().toLowerCase() === 'latest') invalid();
  return value;
}
export function validateOriginRef(ref) { return checkRef(portable(ref)); }
export function originKey(ref) { return canonicalJSON(validateOriginRef(ref)); }
function refKey(ref) { return canonicalJSON(checkRef(ref)); }
function unique(values, key = value => value) {
  const keys = new Set();
  for (const value of values) { const id = key(value); if (keys.has(id)) invalid(); keys.add(id); }
  return keys;
}
function digestWithout(value, field) {
  const copy = { ...value }; delete copy[field]; return canonicalDigest(copy);
}
function checkManifest(bundle, sealing) {
  if (bundle?.schemaVersion !== 1) fail('BUNDLE_SCHEMA_UNSUPPORTED', 'Unsupported bundle schema version.');
  fields(bundle, MANIFEST_KEYS, sealing ? ['manifestSha256'] : []);
  if (!sealing) sha(bundle.manifestSha256);
  for (const key of ['roots', 'records', 'files', 'links']) array(bundle[key]);
  if (bundle.roots.length === 0) incomplete();
  if (bundle.records.length > 256) exceeded('records');
  if (bundle.links.length > 1024) exceeded('links');
  text(bundle.capturedAt);
  fields(bundle.disclosure, ['includedScope', 'omittedEvidence']);
  text(bundle.disclosure.includedScope); array(bundle.disclosure.omittedEvidence);
  for (const omitted of bundle.disclosure.omittedEvidence) text(omitted);
  const roots = unique(bundle.roots, refKey);
  const records = unique(bundle.records, record => {
    fields(record, RECORD_KEYS, sealing ? ['recordSha256'] : []);
    checkRef(record.ref); object(record.metadata);
    if (record.sourcePins === null || typeof record.sourcePins !== 'object') invalid();
    array(record.requiredFileSha256s); array(record.evidenceRefs);
    unique(record.requiredFileSha256s, value => { sha(value); return value; });
    for (const evidence of record.evidenceRefs) checkRef(evidence);
    if (sealing) record.recordSha256 = digestWithout(record, 'recordSha256');
    else {
      sha(record.recordSha256);
      if (record.recordSha256 !== digestWithout(record, 'recordSha256')) fail('BUNDLE_HASH_MISMATCH', 'A preserved record hash does not match.');
    }
    return refKey(record.ref);
  });
  let total = 0;
  const files = unique(bundle.files, file => {
    fields(file, ['sha256', 'byteLength', 'mime', 'role']); sha(file.sha256);
    if (!Number.isSafeInteger(file.byteLength) || file.byteLength < 0) invalid();
    if (file.byteLength > FILE_LIMIT) exceeded('fileBytes');
    total += file.byteLength; if (total > TOTAL_LIMIT) exceeded('totalFileBytes');
    text(file.mime); text(file.role); return file.sha256;
  });
  for (const root of roots) if (!records.has(root)) incomplete();
  for (const record of bundle.records) for (const hash of record.requiredFileSha256s) if (!files.has(hash)) incomplete();
  for (const link of bundle.links) {
    fields(link, ['from', 'relation', 'to', 'requirement']);
    const from = refKey(link.from); const to = refKey(link.to);
    if (!RELATIONS.has(link.relation) || !['runtime', 'historical-reference'].includes(link.requirement)) invalid();
    if (!records.has(from) || (link.requirement === 'runtime' && !records.has(to))) incomplete();
  }
  if (sealing) bundle.manifestSha256 = digestWithout(bundle, 'manifestSha256');
  else if (bundle.manifestSha256 !== digestWithout(bundle, 'manifestSha256')) fail('BUNDLE_HASH_MISMATCH', 'The manifest hash does not match.');
  if (Buffer.byteLength(canonicalJSON(bundle)) > MANIFEST_LIMIT) exceeded('manifestBytes');
  return bundle;
}

export function sealBundle(manifestWithoutDigest) { return checkManifest(portable(manifestWithoutDigest), true); }

function checkBytes(bundle, bytes) {
  object(bytes);
  if (![Object.prototype, null].includes(Object.getPrototypeOf(bytes))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(bytes);
  const expected = new Map(bundle.files.map(file => [file.sha256, file]));
  const buffers = new Map();
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (typeof key !== 'string' || !SHA256.test(key) || !expected.has(key) || !descriptor.enumerable || !('value' in descriptor)) invalid();
    const values = descriptor.value;
    if (isProxy(values) || !Array.isArray(values) || Object.getPrototypeOf(values) !== Array.prototype) invalid();
    const lengthDescriptor = Object.getOwnPropertyDescriptor(values, 'length');
    const length = lengthDescriptor.value;
    if (length > FILE_LIMIT) exceeded('fileBytes');
    // Arrays can be large; inspect one descriptor at a time instead of allocating
    // millions of descriptors or making a JSON representation of byte data.
    if (Reflect.ownKeys(values).length !== length + 1) invalid();
    const buffer = Buffer.alloc(length);
    for (let index = 0; index < length; index++) {
      const item = Object.getOwnPropertyDescriptor(values, String(index));
      if (!item || !item.enumerable || !('value' in item) || !Number.isInteger(item.value) || item.value < 0 || item.value > 255) invalid();
      buffer[index] = item.value;
    }
    if (length !== expected.get(key).byteLength) incomplete();
    if (createHash('sha256').update(buffer).digest('hex') !== key) fail('BUNDLE_HASH_MISMATCH', 'A bundle file hash does not match.');
    buffers.set(key, buffer);
  }
  for (const hash of expected.keys()) if (!Object.hasOwn(descriptors, hash)) incomplete();
  return buffers;
}
export function validateBundle(bundle, bytesBySha256) {
  const safe = checkManifest(portable(bundle), false);
  if (arguments.length > 1) checkBytes(safe, bytesBySha256);
  return safe;
}

async function safeAncestors(path) {
  const absolute = resolve(path); const root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split('/').filter(Boolean)) {
    current = join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) invalid();
  }
  return absolute;
}
async function boundedRead(path, max) {
  await safeAncestors(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) invalid();
    if (stat.size > max) exceeded(max === MANIFEST_LIMIT ? 'manifestBytes' : 'fileBytes');
    const chunks = []; let total = 0;
    while (total <= max) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, max + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead)); total += bytesRead;
    }
    if (total > max) exceeded(max === MANIFEST_LIMIT ? 'manifestBytes' : 'fileBytes');
    await safeAncestors(path);
    return Buffer.concat(chunks, total);
  } finally { await handle.close(); }
}
export async function readBundleDirectory(directory) {
  try {
    directory = resolve(directory);
    await safeAncestors(directory);
    const manifest = await boundedRead(join(directory, 'manifest.json'), MANIFEST_LIMIT);
    let value;
    try { value = JSON.parse(manifest.toString('utf8')); } catch { invalid(); }
    const bundle = validateBundle(value);
    const bytes = {};
    for (const file of bundle.files) {
      const buffer = await boundedRead(join(directory, 'files', file.sha256), FILE_LIMIT);
      if (buffer.length !== file.byteLength) incomplete();
      if (createHash('sha256').update(buffer).digest('hex') !== file.sha256) fail('BUNDLE_HASH_MISMATCH', 'A bundle file hash does not match.');
      bytes[file.sha256] = [...buffer];
    }
    return { bundle, bytes };
  } catch (error) { throw publicError(error, 'BUNDLE_INCOMPLETE', true); }
}
async function exclusiveWrite(path, bytes) {
  await safeAncestors(dirname(path));
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); } finally { await handle.close(); }
}
export async function writeBundleDirectory(directory, { bundle, bytes }) {
  const safe = validateBundle(bundle);
  const buffers = checkBytes(safe, bytes);
  let created = false;
  try {
    directory = resolve(directory);
    await safeAncestors(dirname(directory));
    try { await safeAncestors(directory); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await mkdir(directory, { mode: 0o700 }); created = true;
    await mkdir(join(directory, 'files'), { mode: 0o700 });
    for (const file of safe.files) await exclusiveWrite(join(directory, 'files', file.sha256), buffers.get(file.sha256));
    await exclusiveWrite(join(directory, 'manifest.json'), canonicalJSON(safe));
  } catch (error) {
    if (created) await rm(directory, { recursive: true, force: true });
    throw publicError(error, 'BUNDLE_INCOMPLETE', true);
  }
}
