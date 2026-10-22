import { canonicalJSON } from './contracts.js';

// One policy for source redaction, Library projections and portable manifests.
// Literal prose/URLs remain data; these fields carry private connection authority.
const PRIVATE_KEYS = new Set([
  'path', 'filepath', 'rootdir', 'sourcepath', 'worldroot', 'directory',
  'absolutepath', 'locator', 'sourcefingerprint', 'executableinstruction',
  'fetchinstruction', 'fetchuri', 'fetchurl', 'key', 'apikey', 'cookie',
  'cookies', 'token', 'accesstoken', 'refreshtoken', 'bearertoken',
  'authorization', 'password', 'credential', 'credentials', 'secret',
  'session', 'sessionid',
]);
export const isPrivatePortableKey = key => PRIVATE_KEYS.has(key.replaceAll(/[_-]/g, '').toLowerCase());

export function stripPrivateFields(value) {
  // Validate before traversal so an accessor cannot run during redaction.
  const safe = JSON.parse(canonicalJSON(value));
  function visit(item) {
    if (Array.isArray(item)) return item.map(visit);
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(Object.entries(item)
      .filter(([key]) => !isPrivatePortableKey(key))
      .map(([key, child]) => [key, visit(child)]));
  }
  return visit(safe);
}
