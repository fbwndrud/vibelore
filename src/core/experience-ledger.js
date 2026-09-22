import { createPublicationUnit } from './publication-unit.js';

export async function loadCurrentExperienceLedger({ store, workId }) {
  const publication = await createPublicationUnit({ rootDir: store.rootDir }).readPublished();
  if (!publication.ok) throw new Error(`CORRUPT_PUBLICATION: ${publication.error.code}`);
  const currentHead = publication.value?.head ?? 'legacy-working-tree';
  const ledger = typeof store.loadExperienceLedger === 'function'
    ? await store.loadExperienceLedger(workId)
    : { schemaVersion: 1, sourceHead: null, entries: await store.loadPatternLedger(workId) };
  const sourceHead = ledger?.sourceHead ?? null;
  const fresh = sourceHead === null || sourceHead === currentHead;
  return {
    schemaVersion: Number(ledger?.schemaVersion ?? 1), sourceHead, currentHead, criticVersion: ledger?.criticVersion ?? null,
    status: fresh ? 'fresh' : 'stale', entries: fresh ? (ledger?.entries ?? []) : [],
  };
}

export async function saveExperienceLedgerForHead({ store, workId, sourceHead, entries, criticVersion = null }) {
  const normalized = [...(entries ?? [])].sort((a, b) => a.chapter - b.chapter).map((entry) => ({
    ...entry, sourceHead, ...(criticVersion ? { criticVersion } : {}),
  }));
  const ledger = {
    schemaVersion: 2, sourceHead, criticVersion,
    entries: normalized, updatedAt: new Date().toISOString(),
  };
  await store.saveExperienceLedger(workId, ledger);
  return ledger;
}
