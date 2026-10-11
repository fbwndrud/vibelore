import { isAbsolute } from 'node:path';
import { LoreRegistryStore } from '../store/lore-registry-store.js';
import { LORE_CAPABILITIES, compileLoreRegistry } from '../../engine/src/lore/registry.js';
import { lorePresetDefinitions } from '../../engine/src/lore/presets.js';
import { createLoreResolver } from '../../engine/src/lore/resolve.js';
import { LORE_UNSUPPORTED_CAPABILITIES } from '../../engine/src/lore/extend.js';
import { requireLore } from '../../engine/src/lore/schemas.js';

/** The host AI searches/reuses/proposes definitions; the tool validates and publishes add-only changes. */
export async function runLoreRegistry(args) {
  const actionFields = { status: ['revisionId'], search: ['revisionId', 'search', 'namespace', 'subjectTypeId', 'limit'], register: ['expectedHead', 'definitions', 'preset', 'reason'], ensure: ['expectedHead', 'needs', 'reason', 'operationId'], resolve: ['revisionId', 'input', 'query'] };
  requireLore(actionFields[args.action] && Object.keys(args).every(key => ['action', 'registryRoot', 'universeId', ...actionFields[args.action]].includes(key)), 'INVALID_LORE_DATA', 'unsupported argument for registry action');
  requireLore(isAbsolute(args.registryRoot ?? ''), 'INVALID_LORE_DATA', 'registryRoot must be an explicit absolute world directory');
  const store = new LoreRegistryStore(args.registryRoot, args.universeId);
  if (args.action === 'register') {
    requireLore(args.revisionId === undefined, 'INVALID_LORE_DATA', 'register uses expectedHead, not revisionId');
    requireLore(Object.hasOwn(args, 'expectedHead'), 'INVALID_LORE_DATA', 'register requires expectedHead; use status first');
    const definitions = [...(args.preset ? lorePresetDefinitions(args.universeId, args.preset) : []), ...(args.definitions ?? [])];
    const result = await store.register({ expectedHead: args.expectedHead, definitions, reason: args.reason });
    return { status: 'registered', head: result.head, previousHead: result.previousHead, registryRevisionId: result.registry.revisionId,
      addedRevisionIds: result.addedRevisionIds, reusedRevisionIds: result.reusedRevisionIds };
  }
  if (args.action === 'ensure') {
    requireLore(Array.isArray(args.needs) && typeof args.reason === 'string' && args.reason.trim(), 'INVALID_LORE_DATA', 'ensure requires needs[{definition, why?}] and reason');
    return store.ensure({ needs: args.needs, reason: args.reason, operationId: args.operationId, expectedHead: args.expectedHead });
  }
  const { head, registry } = await store.read(args.revisionId);
  const compiled = compileLoreRegistry(registry);
  switch (args.action) {
    case 'status': return { status: 'ok', head, registryRevisionId: registry.revisionId, universeId: registry.universeId,
      definitionCount: registry.definitions.length, capabilities: LORE_CAPABILITIES, unsupportedCapabilities: LORE_UNSUPPORTED_CAPABILITIES, presets: ['base', 'fantasy'] };
    case 'search': return { status: 'ok', head, ...compiled.search({ query: args.search ?? '', namespace: args.namespace, subjectTypeId: args.subjectTypeId, limit: args.limit }) };
    case 'resolve': {
      requireLore(args.revisionId && args.input && args.query, 'INVALID_LORE_DATA', 'resolve requires pinned revisionId, input and query');
      requireLore(Object.keys(args.input).every(key => ['entities', 'timelines', 'values'].includes(key)), 'INVALID_LORE_DATA', 'unsupported resolver input field');
      return createLoreResolver({ ...args.input, registry }).resolve(args.query);
    }
    default: requireLore(false, 'INVALID_LORE_DATA', 'unsupported registry action');
  }
}
