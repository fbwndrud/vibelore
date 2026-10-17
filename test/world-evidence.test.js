import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createWorkBinding, prepareLoreProduction } from '../engine/src/lore/production.js';
import { renderProductionContext } from '../src/core/production-input.js';
import { sharedWorld, sharedBinding } from './fixtures/shared-lore.js';
import { hashLore } from '../engine/src/lore/registry.js';
import { validateLoreContent } from '../engine/src/lore/changes.js';
import { runUniverse } from '../src/tools/universe.js';

function withLedger(original) {
  const content = structuredClone(original), source = content.documents.find(d => d.id === 'profile');
  content.evidenceLedger = { schemaVersion: 1,
    evidence: [{ id: 'name-source', basis: 'text-explicit', documentId: 'profile', sourceHash: hashLore(source.text), span: { from: 2, to: 4 }, quote: '윤재', dependsOn: [] }],
    claims: [{ id: 'name-claim', statement: '이 인물의 이름은 윤재다.', subjectId: 'character-a', perspective: { kind: 'world' }, canonStatus: 'adopted', valueId: 'name-a', evidenceIds: ['name-source'], contradictingEvidenceIds: [], dependsOn: [] }],
    questions: [{ id: 'name-origin', question: '누가 이 이름을 지었는가?', status: 'open', disposition: null, evidenceIds: [], contradictingEvidenceIds: [], resolutionEvidenceIds: [], dependsOn: [] }],
  };
  return content;
}
function rpc(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/server.js'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, VIBELORE_MCP_SURFACE: 'public' } });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`MCP timeout: ${stderr}`)); }, 20000);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); if (code !== 0) return reject(new Error(stderr)); try { resolve(JSON.parse(stdout.trim().split('\n').at(-1)).result); } catch (error) { reject(error); } });
    child.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'lore_universe', arguments: args } })}\n`);
  });
}
async function world(t) { const w = await sharedWorld(); t.after(() => rm(w.root, { recursive: true, force: true })); return w; }

describe('scoped world evidence', () => {
  it('seals an optional ledger through public proposal/approval and reads only the pinned revision', async t => {
    const w = await world(t), args = { worldRoot: w.root, universeId: 'u1' }, content = withLedger(w.content);
    const docs = await rpc({ ...args, action: 'documents', loreRevisionId: w.head });
    assert.equal(docs.structuredContent.documents.find(d => d.id === 'profile').sourceHash, content.evidenceLedger.evidence[0].sourceHash);
    const proposed = await rpc({ ...args, action: 'propose', expectedHead: w.head, registryRevisionId: w.registry.revisionId, content, reason: '근거 기록' });
    assert.equal(proposed.isError, undefined, JSON.stringify(proposed));
    assert.equal((await w.world.status()).head, w.head);
    const accepted = await rpc({ ...args, action: 'decide', expectedHead: w.head, proposalId: proposed.structuredContent.proposalId, decision: 'approve' });
    assert.equal(accepted.structuredContent.status, 'adopted');
    const revision = accepted.structuredContent.head;
    const result = await rpc({ ...args, action: 'evidence', loreRevisionId: revision, query: { valueId: 'name-a' } });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.equal(result.structuredContent.claims[0].canonStatus, 'adopted');
    assert.equal(result.structuredContent.evidence[0].quote, '윤재');
    assert.equal(result.structuredContent.loreRevisionId, revision);
    const old = await rpc({ ...args, action: 'evidence', loreRevisionId: w.head, query: { valueId: 'name-a' } });
    assert.equal(old.structuredContent.status, 'legacy_unclassified');
    assert.deepEqual(old.structuredContent.sourceDocumentIds, ['profile']);
    const stored = await w.world.read(revision);
    assert.deepEqual(stored.revision.content.values[0].evidenceIds, ['profile']);
  });
  it('requires an explicit revision even for evidence summary', async t => {
    const w = await world(t);
    await assert.rejects(runUniverse({ action: 'evidence', worldRoot: w.root, universeId: 'u1' }), { code: 'INVALID_LORE_DATA' });
  });
  it('accepts author-decided canon without pretending it is revealed to readers', async t => {
    const w = await world(t), content = withLedger(w.content), e = content.evidenceLedger.evidence[0];
    Object.assign(e, { basis: 'author-decision', span: null, quote: null });
    content.evidenceLedger.questions[0].status = 'blocked';
    assert.doesNotThrow(() => validateLoreContent({ registry: w.registry, content }));
    assert.equal(Object.hasOwn(content.evidenceLedger.claims[0], 'readerVisibility'), false);
  });
  it('preserves a quoted historical source after a later world revision changes it', async t => {
    const w = await world(t), content = withLedger(w.content);
    const p = await w.world.propose({ expectedHead: w.head, registryRevisionId: w.registry.revisionId, content, reason: '근거 추가' });
    const first = await w.world.decide({ expectedHead: w.head, proposalId: p.proposalId, action: 'approve' });
    const next = structuredClone(content); next.documents.find(d => d.id === 'profile').text += '새 작가 메모\n';
    await assert.rejects(w.world.propose({ expectedHead: first.head, registryRevisionId: w.registry.revisionId, content: next, reason: '근거 갱신 전' }), { code: 'LORE_EVIDENCE_SOURCE_MISMATCH' });
    next.evidenceLedger.evidence[0].sourceHash = hashLore(next.documents.find(d => d.id === 'profile').text);
    const p2 = await w.world.propose({ expectedHead: first.head, registryRevisionId: w.registry.revisionId, content: next, reason: '근거 갱신' });
    await w.world.decide({ expectedHead: first.head, proposalId: p2.proposalId, action: 'approve' });
    const old = await runUniverse({ action: 'evidence', worldRoot: w.root, universeId: 'u1', loreRevisionId: first.head, query: { valueId: 'name-a' } });
    assert.equal(old.evidence[0].sourceHash, content.evidenceLedger.evidence[0].sourceHash);
    assert.equal(old.evidence[0].quote, '윤재');
  });
  it('keeps proposed interpretations out of actual production context while preserving them in the lock', async t => {
    const w = await world(t), content = withLedger(w.content), ledger = content.evidenceLedger;
    ledger.evidence.push({ id: 'private-guess', basis: 'model-inferred', documentId: 'secret', sourceHash: hashLore(content.documents.find(d => d.id === 'secret').text), span: null, quote: null, dependsOn: [] });
    ledger.claims.push({ ...ledger.claims[0], id: 'private-claim', statement: 'PROPOSED_INTERPRETATION_ONLY', valueId: null, canonStatus: 'proposed', evidenceIds: ['private-guess'] });
    const p = await w.world.propose({ expectedHead: w.head, registryRevisionId: w.registry.revisionId, content, reason: '해석은 후보로 보존' });
    const published = await w.world.decide({ expectedHead: w.head, proposalId: p.proposalId, action: 'approve' });
    const prepared = prepareLoreProduction({ binding: createWorkBinding(sharedBinding({ ...w, head: published.head }, 'novel')), publication: await w.world.read(published.head), chapter: 1 });
    assert.equal(prepared.status, 'ready');
    assert.equal(prepared.lock.closure.publication.revision.content.evidenceLedger.claims.length, 2);
    const prompt = renderProductionContext(prepared.lock, { characters: [] });
    assert.doesNotMatch(prompt, /PROPOSED_INTERPRETATION_ONLY|FUTURE_SECRET_TOKEN/);
  });
  for (const [name, change, code] of [
    ['stale hashes', c => { c.evidenceLedger.evidence[0].sourceHash = `sha256:${'0'.repeat(64)}`; }, 'LORE_EVIDENCE_SOURCE_MISMATCH'],
    ['incorrect exact spans', c => { c.evidenceLedger.evidence[0].span.to = 3; }, 'LORE_EVIDENCE_SPAN_MISMATCH'],
    ['missing evidence refs', c => { c.evidenceLedger.claims[0].evidenceIds = ['missing']; }, 'LORE_EVIDENCE_REFERENCE'],
    ['evidence cycles', c => { c.evidenceLedger.evidence[0].dependsOn = ['name-source']; }, 'LORE_EVIDENCE_CYCLE'],
    ['claim cycles', c => { c.evidenceLedger.claims[0].dependsOn = ['name-claim']; }, 'LORE_EVIDENCE_CYCLE'],
    ['question cycles', c => { c.evidenceLedger.questions[0].dependsOn = ['name-origin']; }, 'LORE_EVIDENCE_CYCLE'],
    ['inferred world truth', c => { c.evidenceLedger.evidence[0].basis = 'model-inferred'; }, 'LORE_CLAIM_UNSUPPORTED'],
    ['character reports as world truth', c => { c.evidenceLedger.evidence[0].basis = 'character-report'; }, 'LORE_CLAIM_UNSUPPORTED'],
    ['proposed claims backing adopted values', c => { c.evidenceLedger.claims[0].canonStatus = 'proposed'; }, 'LORE_CLAIM_UNSUPPORTED'],
    ['character-perspective world values', c => { c.evidenceLedger.claims[0].perspective = { kind: 'character', characterId: 'character-a' }; }, 'LORE_CLAIM_PERSPECTIVE'],
    ['unresolved contradictions on adopted claims', c => { c.evidenceLedger.claims[0].contradictingEvidenceIds = ['name-source']; }, 'LORE_CLAIM_CONTRADICTED'],
    ['verified questions without evidence', c => { Object.assign(c.evidenceLedger.questions[0], { status: 'resolved', disposition: 'verified' }); }, 'LORE_QUESTION_UNSUPPORTED'],
    ['invented properties', c => { c.evidenceLedger.evidence[0].confidence = 1; }, 'INVALID_LORE_DATA'],
  ]) it(`rejects ${name}`, async t => {
    const w = await world(t), content = withLedger(w.content); change(content);
    assert.throws(() => validateLoreContent({ registry: w.registry, content }), { code });
  });
  it('does not adopt a character claim based on another private perspective', async t => {
    const w = await world(t), content = withLedger(w.content), ledger = content.evidenceLedger;
    content.entities.push({ id: 'character-b', typeDefinitionRevisionId: content.entities[0].typeDefinitionRevisionId, documentIds: [], valueIds: [] });
    ledger.claims = ['character-a', 'character-b'].map((characterId, index) => ({ ...ledger.claims[0], id: `belief-${index}`, valueId: null,
      perspective: { kind: 'character', characterId }, dependsOn: index ? [] : ['belief-1'] }));
    assert.throws(() => validateLoreContent({ registry: w.registry, content }), { code: 'LORE_CLAIM_UNSUPPORTED' });
    ledger.claims[1].perspective.characterId = 'character-a';
    assert.doesNotThrow(() => validateLoreContent({ registry: w.registry, content }));
  });
  it('does not let an adopted world claim depend on a proposed interpretation', async t => {
    const w = await world(t), content = withLedger(w.content), ledger = content.evidenceLedger;
    ledger.claims.push({ ...ledger.claims[0], id: 'guess', canonStatus: 'proposed', valueId: null });
    ledger.claims[0].dependsOn = ['guess'];
    assert.throws(() => validateLoreContent({ registry: w.registry, content }), { code: 'LORE_CLAIM_UNSUPPORTED' });
  });
  it('does not verify a question while a required question remains open', async t => {
    const w = await world(t), content = withLedger(w.content), ledger = content.evidenceLedger;
    ledger.questions.push({ ...ledger.questions[0], id: 'dependency' });
    Object.assign(ledger.questions[0], { status: 'resolved', disposition: 'verified', evidenceIds: ['name-source'], resolutionEvidenceIds: ['name-source'], dependsOn: ['dependency'] });
    assert.throws(() => validateLoreContent({ registry: w.registry, content }), { code: 'LORE_QUESTION_UNSUPPORTED' });
  });
  it('rejects null content with a stable validation error', async t => {
    const w = await world(t);
    assert.throws(() => validateLoreContent({ registry: w.registry, content: null }), { code: 'INVALID_LORE_DATA' });
  });
  it('does not qualify a derivation with one explicit dependency and one inference', async t => {
    const w = await world(t), content = withLedger(w.content), ledger = content.evidenceLedger;
    ledger.evidence.push({ ...ledger.evidence[0], id: 'guess', basis: 'model-inferred' }, { ...ledger.evidence[0], id: 'derived', basis: 'rule-derived', dependsOn: ['name-source', 'guess'] });
    ledger.claims[0].evidenceIds = ['derived'];
    assert.throws(() => validateLoreContent({ registry: w.registry, content }), { code: 'LORE_CLAIM_UNSUPPORTED' });
  });
  it('allows proposed interpretations and verified or withdrawn questions without creating values', async t => {
    const w = await world(t), content = withLedger(w.content), ledger = content.evidenceLedger;
    ledger.claims.push({ ...ledger.claims[0], id: 'guess-claim', valueId: null, canonStatus: 'proposed', perspective: { kind: 'character', characterId: 'character-a' }, contradictingEvidenceIds: ['name-source'] });
    Object.assign(ledger.questions[0], { status: 'resolved', disposition: 'verified', evidenceIds: ['name-source'], resolutionEvidenceIds: ['name-source'] });
    assert.doesNotThrow(() => validateLoreContent({ registry: w.registry, content }));
    Object.assign(ledger.questions[0], { disposition: 'withdrawn', resolutionEvidenceIds: [] });
    assert.doesNotThrow(() => validateLoreContent({ registry: w.registry, content }));
    assert.equal(content.values.length, 3);
  });
});
