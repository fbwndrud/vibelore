import { isAbsolute } from 'node:path';
import { AssetCatalogStore } from '../store/asset-catalog-store.js';
import { requireLore } from '../../engine/src/lore/schemas.js';
import { inspectSceneScript, applySceneScript, sceneScriptStatus } from '../core/scene-script.js';

const only = (args, common, allowed) => requireLore(allowed[args.action] && Object.keys(args).every(k => [...common, ...allowed[args.action]].includes(k)), 'INVALID_LORE_DATA', 'invalid action/input');

/** World-root asset catalog: candidates are inert until the author approves them. */
export async function runAssets(args) {
  only(args, ['action', 'worldRoot', 'universeId'], { status: [], propose: ['expectedHead', 'loreRevisionId', 'assets', 'profiles', 'reason'], decide: ['proposalId', 'expectedHead', 'decision'], recover: [] });
  requireLore(isAbsolute(args.worldRoot ?? ''), 'INVALID_LORE_DATA', 'worldRoot must be an absolute world directory');
  const catalog = new AssetCatalogStore(args.worldRoot, args.universeId);
  switch (args.action) {
    case 'status': return catalog.status();
    case 'propose': requireLore(Object.hasOwn(args, 'expectedHead'), 'INVALID_LORE_DATA', 'expectedHead required'); return catalog.propose(args);
    case 'decide': return catalog.decide({ proposalId: args.proposalId, expectedHead: args.expectedHead, decision: args.decision });
    case 'recover': return catalog.recover();
  }
}

/** Work-owned standalone scene scripts: the production source of a work without a novel. */
export async function runSceneScript({ store, args }) {
  only(args, ['action', 'project', 'workId'], { status: ['scriptId'], inspect: ['worldRoot', 'script'], apply: ['proposalId', 'expectedHead'] });
  switch (args.action) {
    case 'status': return sceneScriptStatus({ store, scriptId: args.scriptId });
    case 'inspect': return inspectSceneScript({ store, workId: args.workId, worldRoot: args.worldRoot, script: args.script });
    case 'apply': requireLore(Object.hasOwn(args, 'expectedHead'), 'INVALID_LORE_DATA', 'expectedHead required'); return applySceneScript({ store, workId: args.workId, proposalId: args.proposalId, expectedHead: args.expectedHead });
  }
}
