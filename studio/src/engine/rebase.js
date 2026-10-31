import { executionImpacts } from './jobs.js';
import { assertText, canonicalDigest, fail } from './contracts.js';
import { readValues, requireValue } from './story.js';
export function registerRebaseCommands(service) {
  service.store.write(() =>
    service.store.db.exec(
      `CREATE TABLE IF NOT EXISTS source_changes(project_id TEXT NOT NULL REFERENCES projects(id),id TEXT NOT NULL,production_id TEXT NOT NULL,data_json TEXT NOT NULL,PRIMARY KEY(project_id,id));`
    )
  );
  service.registerCommand('source.rebase', {
    target: ({ envelope }) => ({ kind: 'sourceBinding', id: envelope.payload.productionId }),
    validate({ store, envelope }) {
      const p = envelope.payload;
      requireValue(store, envelope.projectId, 'production', p.productionId);
      assertText(p.actor);
      assertText(p.reason);
      const pending = store
        .all(
          'SELECT data_json FROM source_changes WHERE project_id=? AND production_id=?',
          envelope.projectId,
          p.productionId
        )
        .map((r) => JSON.parse(r.data_json))
        .find((d) => d.status === 'pending');
      if (p.action) {
        if (!pending || pending.id !== p.decisionId)
          fail('INVALID_REFERENCE', 'Pending rebase decision is absent.');
        if (!['keep_existing', 'apply'].includes(p.action)) fail('INVALID_INPUT', 'Unknown rebase decision.');
        if (p.action === 'apply') {
          for (const impact of pending.impacts) {
            if (
              store.aggregate(envelope.projectId, { kind: 'scene', id: impact.sceneId }).revision !==
              impact.sceneRevision
            )
              fail('REVISION_CONFLICT', 'Affected scene changed since source review.');
            for (const [id, revision] of Object.entries(impact.utteranceRevisions)) {
              if (store.aggregate(envelope.projectId, { kind: 'utterance', id }).revision !== revision)
                fail('REVISION_CONFLICT', 'Affected utterance changed since source review.');
            }
          }
          const scenes = readValues(store, envelope.projectId, 'scene').filter(
            (s) => s.productionId === p.productionId
          );
          if (
            !Array.isArray(p.choices) ||
            p.choices.length !== scenes.length ||
            new Set(p.choices.map((c) => c.sceneId)).size !== scenes.length ||
            scenes.some(
              (s) =>
                !p.choices.some(
                  (c) =>
                    c.sceneId === s.id && ['replan', 'keep_override', 'return_to_source'].includes(c.action)
                )
            )
          )
            fail('REBASE_UNRESOLVED', 'Every affected scene needs an explicit rebase choice.');
        }
      } else {
        if (pending) fail('REBASE_UNRESOLVED', 'Resolve the pending source decision first.');
        requireValue(store, envelope.projectId, 'sourcePackage', p.sourcePackageId);
      }
    },
    apply({ store, envelope }) {
      const p = envelope.payload,
        production = requireValue(store, envelope.projectId, 'production', p.productionId);
      let decision;
      if (p.action) {
        decision = JSON.parse(
          store.get(
            'SELECT data_json FROM source_changes WHERE project_id=? AND id=?',
            envelope.projectId,
            p.decisionId
          ).data_json
        );
        if (production.sourcePackageId !== decision.fromPackageId)
          fail('REVISION_CONFLICT', 'Source binding changed during rebase.');
        decision = {
          ...decision,
          status: p.action === 'apply' ? 'applied' : 'kept_existing',
          choices: p.choices ?? [],
          resolution: { actor: p.actor, reason: p.reason },
        };
        if (p.action === 'apply')
          store.run(
            'UPDATE productions SET source_package_id=? WHERE project_id=? AND id=?',
            decision.toPackageId,
            envelope.projectId,
            p.productionId
          );
      } else {
        const old = production.sourcePackageId
            ? requireValue(store, envelope.projectId, 'sourcePackage', production.sourcePackageId)
            : null,
          next = requireValue(store, envelope.projectId, 'sourcePackage', p.sourcePackageId);
        if (old?.id === next.id) fail('INVALID_INPUT', 'Source binding is already selected.');
        const input = (pkg) =>
          pkg
            ? {
                textUnits: pkg.textUnits.map((u) => ({ id: u.id, text: u.text })),
                blobs: pkg.blobManifest.map((b) => b.blobId),
              }
            : null;
        decision = {
          id: envelope.commandId,
          productionId: p.productionId,
          fromPackageId: old?.id ?? null,
          toPackageId: next.id,
          status: 'pending',
          actor: p.actor,
          reason: p.reason,
          diff: {
            inputBytesEqual: canonicalDigest(input(old)) === canonicalDigest(input(next)),
            semanticValidity: 'needs_review',
            oldSourceDigest: old?.sourceDigest ?? null,
            newSourceDigest: next.sourceDigest,
          },
          impacts: readValues(store, envelope.projectId, 'scene')
            .filter((s) => s.productionId === p.productionId)
            .map((s) => ({
              sceneId: s.id,
              sceneRevision: store.aggregate(envelope.projectId, { kind: 'scene', id: s.id }).revision,
              sourcePackageId: s.sourcePackageId ?? old?.id ?? null,
              reason: 'review-stale:source-binding',
              scope: 'scene',
              utteranceIds: s.utterances.map((u) => u.id),
              utteranceRevisions: Object.fromEntries(
                s.utterances.map((u) => [
                  u.id,
                  store.aggregate(envelope.projectId, { kind: 'utterance', id: u.id }).revision,
                ])
              ),
              shotIds: s.shots.map((sh) => sh.id),
            })),
        };
      }
      decision.executionImpacts = executionImpacts(store, envelope.projectId, p.productionId);
      store.run(
        'INSERT INTO source_changes(project_id,id,production_id,data_json) VALUES(?,?,?,?) ON CONFLICT(project_id,id) DO UPDATE SET data_json=excluded.data_json',
        envelope.projectId,
        decision.id,
        p.productionId,
        JSON.stringify(decision)
      );
      return decision;
    },
  });
}
