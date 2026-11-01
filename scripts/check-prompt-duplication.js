#!/usr/bin/env node
/**
 * Developer-only prompt duplication check. Not part of the package, any npm script or any test.
 * Run it once, right before pushing; never during development.
 *
 *   node scripts/check-prompt-duplication.js              build fixture workflows in a temp dir and check their requests
 *   node scripts/check-prompt-duplication.js --self-test  run the analysis on a built-in duplicated payload
 *
 * The fixture workflows are driven through the real lore_webtoon_scene handlers (novel source, an adopted style whose
 * bytes equal a user reference, a previous scene, a v1 composition with a non-empty digest), so every request below is
 * assembled by product code, never by hand:
 *   webtoon-scene-plan, webtoon-scene-preflight, the image job (prompt + referenceImages), webtoon-scene-image-review.
 *
 * Reported per request: a duplicate attachment (same bytes attached twice), a sentence of 6 or more words that occurs more
 * than once in the request text, and a composition digest line that occurs more than once.
 *
 * Exit codes of the real check: 0 clean, 1 duplicates listed as "request -> source A / source B", 2 the fixture could not be built.
 * Exit codes of --self-test: 0 the planted duplicates were detected and the clean payload stayed clean (the analysis of the
 * planted payload yields exit 1, which is the expected outcome), 1 the analysis missed a planted duplicate or flagged the
 * clean payload, so the check itself cannot be trusted.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';
import { pathToFileURL, fileURLToPath } from 'node:url';

const MIN_WORDS = 6;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = path => pathToFileURL(join(root, path)).href;

// ---- analysis ---------------------------------------------------------------

/**
 * A request record is `{ name, leaves: [{ source, text }], attachments: [{ source, hash }], digestLines: string[] }`.
 * Returns findings `{ request, kind, detail, sources }`; `sources` always lists every place the duplicate occurs.
 */
function analyze(record) {
  const findings = [], request = record.name, short = text => text.length > 90 ? `${text.slice(0, 87)}...` : text;
  const byHash = new Map();
  for (const a of record.attachments) byHash.set(a.hash, [...(byHash.get(a.hash) ?? []), a.source]);
  for (const [hash, sources] of byHash) if (sources.length > 1) findings.push({ request, kind: 'attachment', detail: `same bytes ${hash.slice(0, 12)}`, sources });
  const bySentence = new Map();
  for (const { source, text } of record.leaves) {
    for (const raw of text.split(/(?<=[.!?。！？])\s+|\n+/)) {
      const sentence = raw.replace(/\s+/g, ' ').trim();
      if (sentence.split(' ').filter(Boolean).length >= MIN_WORDS) bySentence.set(sentence, [...(bySentence.get(sentence) ?? []), source]);
    }
  }
  for (const [sentence, sources] of bySentence) if (sources.length > 1) findings.push({ request, kind: 'sentence', detail: short(sentence), sources });
  for (const line of new Set(record.digestLines)) {
    const sources = record.leaves.flatMap(({ source, text }) => Array(text.split(line).length - 1).fill(source));
    if (sources.length > 1) findings.push({ request, kind: 'digest', detail: short(line), sources });
  }
  return findings;
}

const format = f => `${f.request} → ${f.sources.join(' / ')}  [${f.kind}] ${f.detail}`;
const report = records => {
  const findings = records.flatMap(analyze);
  for (const f of findings) console.log(format(f));
  return { findings, code: findings.length ? 1 : 0 };
};

function selfTest() {
  const line = 'Recent pages keep closing on the same medium shot, so vary the closing frame.';
  const planted = { name: 'planted-request', digestLines: [line],
    leaves: [{ source: 'system', text: `${line} Keep the lettering exactly as written.` }, { source: 'user.compositionDigest[0]', text: line },
      { source: 'user.plan.intent', text: 'A person waits outside a door and listens.' }, { source: 'user.source[0].text', text: 'A person waits outside a door and listens.' }],
    attachments: [{ source: 'images[0]', hash: 'a'.repeat(64) }, { source: 'images[1]', hash: 'a'.repeat(64) }] };
  const clean = { name: 'clean-request', digestLines: [line],
    leaves: [{ source: 'system', text: 'Keep the lettering exactly as written.' }, { source: 'user.compositionDigest[0]', text: line }, { source: 'user.note', text: 'Too short.' }, { source: 'user.other', text: 'Too short.' }],
    attachments: [{ source: 'images[0]', hash: 'a'.repeat(64) }, { source: 'images[1]', hash: 'b'.repeat(64) }] };
  const found = analyze(planted), kinds = new Set(found.map(f => f.kind));
  console.log('planted payload:');
  const planted_ = report([planted]);
  console.log(`clean payload: ${analyze(clean).length} finding(s)`);
  const ok = planted_.code === 1 && ['attachment', 'sentence', 'digest'].every(k => kinds.has(k)) && analyze(clean).length === 0;
  console.log(ok ? 'SELF-TEST PASS: every planted duplicate was detected (the analysis exit would be 1) and the clean payload stayed clean.'
    : 'SELF-TEST FAIL: the analysis missed a planted duplicate or flagged the clean payload.');
  return ok ? 0 : 1;
}

// ---- request records ----------------------------------------------------------

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
/** Every string leaf of a JSON value with a readable path, e.g. `user.source[0].text`. */
const leavesOf = (value, path) => typeof value === 'string' ? [{ source: path, text: value }]
  : Array.isArray(value) ? value.flatMap((v, i) => leavesOf(v, `${path}[${i}]`))
  : value && typeof value === 'object' ? Object.entries(value).flatMap(([k, v]) => leavesOf(v, path ? `${path}.${k}` : k)) : [];
const parse = text => { try { return JSON.parse(text); } catch { return text; } };
const fileHash = async path => sha(await readFile(path));

/** A model request as the tool hands it to a provider: `{ step, messages, images }`. */
async function modelRecord(req, name, digestLines) {
  const system = req.messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const user = parse(req.messages.filter(m => m.role !== 'system').map(m => m.content).join('\n\n'));
  const images = req.images ?? [];
  return { name, digestLines, leaves: [...leavesOf(system, 'system'), ...leavesOf(user, 'user')],
    attachments: await Promise.all(images.map(async (img, i) => ({ source: `images[${i}]`, hash: await fileHash(img.path) }))) };
}

/** A relayed request as the host sees it: `{ step, system, user, images }`; image roles come from the request's own reference list. */
async function relayRecord(q, name, digestLines) {
  const user = parse(q.user), images = q.images ?? [];
  const roles = i => (user.referenceImages ?? []).filter(r => r.imageIndex === i + 1).map(r => r.id).join('+');
  return { name, digestLines, leaves: [...leavesOf(q.system, 'system'), ...leavesOf(user, 'user')],
    attachments: await Promise.all(images.map(async (img, i) => ({ source: `images[${i}](${roles(i) || 'unlabelled'})`, hash: await fileHash(img.path) }))) };
}

/** The image job: prompt and reference list; each reference is an attachment keyed by its recorded hash. */
function jobRecord(job, name, digestLines) {
  const refs = job.referenceImages ?? [];
  return { name, digestLines, leaves: [...leavesOf(job.prompt, 'prompt'), ...refs.flatMap((r, i) => leavesOf(r.description, `referenceImages[${r.id ?? i}].description`))],
    attachments: refs.map((r, i) => ({ source: `referenceImages[${r.id ?? i}]`, hash: r.hash })) };
}

// ---- fixture workflows (all requests come from the real tool code) ------------------

const png = (r, g, b) => {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]), len = Buffer.alloc(4), crc = Buffer.alloc(4);
    len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from([0, r, g, b]))), chunk('IEND', Buffer.alloc(0))]);
};

async function buildRecords() {
  const [{ runWebtoonSceneTool }, { runWebtoonStyleTool }, { createHostRelay }, { loadRun }, { compositionFingerprint }, fixtures, base] = await Promise.all([
    import(src('src/tools/webtoon-scene.js')), import(src('src/tools/webtoon-style.js')), import(src('src/provider/host-relay.js')), import(src('src/runs.js')),
    import(src('src/core/webtoon-composition.js')), import(src('test/fixtures/webtoon-scene.js')), import(src('test/fixtures/webtoon.js'))]);
  const { sceneSetup, scenePlan, scenePreflight, sceneVisualChecks, sceneCompositionCheck } = fixtures, { workId, pixel } = base;
  const { store, repo, args } = await sceneSetup();
  const cleanup = () => rm(store.rootDir, { recursive: true, force: true });
  try {
    // Earlier adopted pages in the episode, so the digest has lines.
    const plain = angle => ({ shot: 'MS', angle, focal: 'space', background: 'detailed', subjects: [] });
    const rows = [1, 2].flatMap(n => {
      const labels = [plain(n === 1 ? 'high' : 'low'), plain(n === 1 ? 'low' : 'high')], sceneKey = `seed-${n}`;
      return [{ type: 'page', workflowId: `wt-${sceneKey}`, revision: 1, sceneKey, episodeKey: 'ep-0001', status: 'adopted', adoptedAt: '2026-11-01T00:00:00.000Z', layout: 'grid', openPanel: 1, closePanel: labels.length, sceneType: 'dialogue', references: [] },
        ...labels.map((l, i) => ({ type: 'panel', workflowId: `wt-${sceneKey}`, revision: 1, sceneKey, episodeKey: 'ep-0001', panel: i + 1, status: 'adopted', vocabVersion: 1, source: 'plan', confidence: 'clear', label: l, required: [], directed: false, fingerprint: compositionFingerprint(l) }))];
    });
    const shard = repo.path('composition', 'l0', 'ep-0001.jsonl');
    await mkdir(dirname(shard), { recursive: true }); await writeFile(shard, rows.map(r => JSON.stringify(r)).join('\n') + '\n');

    // Adopted style sample with the same bytes as the user reference.
    const sample = join(store.rootDir, 'sample.png'); await writeFile(sample, pixel);
    const proposal = await runWebtoonStyleTool({ store, args: { workId, action: 'propose', brief: 'rough ink', direction: 'Monochrome ink.', imagePath: sample } });
    await runWebtoonStyleTool({ store, args: { workId, action: 'approve', proposalId: proposal.proposalId, feedback: 'use this' } });

    const sent = [];
    const planner = { provenance: { kind: 'fixture' }, async complete(req) {
      sent.push(req);
      const d = JSON.parse(req.messages.at(-1).content);
      if (req.step === 'webtoon-scene-plan') return { text: JSON.stringify(scenePlan(d.source)) };
      const answer = scenePreflight(d); if (d.styleBasis) answer.renderBrief.style = d.styleBasis.profile.style;
      return { text: JSON.stringify(answer) };
    } };
    const answerReview = q => {
      const d = JSON.parse(q.user), s = d.schema;
      return { ...s, ...sceneCompositionCheck(s.compositionCheck), visualChecks: sceneVisualChecks(), inspectedImages: true, observedPanelCount: d.requestedPanelCount, spatialCoherence: true, readingOrder: true,
        evidence: 'Synthetic protocol receipt.', findings: [], textObservations: d.plan.texts.map(t => ({ id: t.id, observedText: t.text, readable: true, speakerCorrect: true, evidence: 'Synthetic text.' })),
        ...(s.styleReview ? { styleReview: { inspectedReference: true, verdict: 'matches', evidence: 'Synthetic style receipt.' } } : {}),
        ...(s.continuity ? { continuity: Object.fromEntries(Object.entries(s.continuity).map(([k, v]) => [k, k === 'inspectedPreviousImage' ? true : { passed: true, evidence: 'Synthetic continuity receipt.' }])) } : {}) };
    };
    const asset = async (job, color) => {
      const path = join(store.rootDir, `generated-${color[0]}.png`); await writeFile(path, png(...color));
      return { path, inputHash: job.inputHash, provenance: { kind: 'openai-api', requestedModel: 'gpt-image-2.5-sunburst', selectionId: 'selected-api' } };
    };
    const start = { ...args, autoRevisions: 0 };
    // Scene 1 is drawn and reviewed so that scene 2 has a passed previous scene.
    const drawn1 = await runWebtoonSceneTool({ store, args: { ...start, sourceUnitIds: ['ch-1-p-1'] }, providers: planner });
    const pending1 = await runWebtoonSceneTool({ store, args: { workId, asset: await asset(drawn1.jobs[0], [200, 30, 30]) }, providers: createHostRelay() });
    const q1 = pending1.requests[0], run1 = await loadRun(store.rootDir, pending1.runId);
    const first = await runWebtoonSceneTool({ store, args: run1.args, run: run1, providers: createHostRelay({ [q1.id]: JSON.stringify(answerReview(q1)) }) });
    if (first.status !== 'completed') throw new Error(`FIXTURE: the first scene ended as ${first.status}`);

    // Scene 2: the requests under test.
    sent.length = 0;
    const drawn2 = await runWebtoonSceneTool({ store, args: { ...start, previousWorkflowId: first.workflowId, sourceUnitIds: ['ch-1-p-2'] }, providers: planner });
    if (drawn2.status !== 'needs_scene_image') throw new Error(`FIXTURE: the second scene ended as ${drawn2.status}`);
    const w = await repo.load();
    const lines = w.compositionVersion === 1 && Array.isArray(w.compositionDigest?.lines) ? w.compositionDigest.lines : [];
    if (!lines.length) throw new Error('FIXTURE: the second scene has no composition digest');
    if (!w.styleSnapshot || !w.previousScene) throw new Error('FIXTURE: the second scene lacks an adopted style or a previous scene');
    const pending2 = await runWebtoonSceneTool({ store, args: { workId, asset: await asset(drawn2.jobs[0], [30, 30, 200]) }, providers: createHostRelay() });
    const q2 = pending2.requests[0];
    if (q2?.step !== 'webtoon-scene-image-review') throw new Error('FIXTURE: no image review request was produced');
    const byStep = step => sent.find(r => r.step === step);
    if (!byStep('webtoon-scene-plan') || !byStep('webtoon-scene-preflight')) throw new Error('FIXTURE: a planning request is missing');
    return [await modelRecord(byStep('webtoon-scene-plan'), 'webtoon-scene-plan', lines), await modelRecord(byStep('webtoon-scene-preflight'), 'webtoon-scene-preflight', lines),
      jobRecord(drawn2.jobs[0], 'image-job', lines), await relayRecord(q2, 'webtoon-scene-image-review', lines)];
  } finally { await cleanup(); }
}

// ---- main ------------------------------------------------------------------------

async function main() {
  if (process.argv.includes('--self-test')) return selfTest();
  let records;
  try { records = await buildRecords(); }
  catch (e) { console.error(`Could not build the fixture workflows: ${e.message}`); return 2; }
  const { findings, code } = report(records);
  console.log(code === 0 ? `Prompt duplication check: ${records.length} requests clean.` : `Prompt duplication check: ${findings.length} duplicate(s) in ${new Set(findings.map(f => f.request)).size} request(s).`);
  return code;
}

process.exit(await main());
