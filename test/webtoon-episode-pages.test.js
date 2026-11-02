import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { workId } from './fixtures/webtoon.js';
import { createHostRelay } from '../src/provider/host-relay.js';
import { loadRun } from '../src/runs.js';
import { runWebtoonEpisodeTool } from '../src/tools/webtoon-episode.js';
import { episodeSetup, provider, pageBriefAnswer, pageReviewAnswer, driveToImage, importPage, importTiles, importPageAndPass, passAll, provenanceFor, episodeCall as tool, pngOf, PAGE_SIZE } from './fixtures/webtoon-episode.js';
import { runConfigureStatus } from '../src/tools/configure.js';
import { WebtoonStore } from '../src/store/webtoon-store.js';
import { digest } from '../src/core/webtoon-contract.js';
import { pngSize } from '../src/core/webtoon-page-review.js';

const drawing = options => provider({ answerPages: true, ...options });
const saved = store => new WebtoonStore(store).load();
const briefRequests = p => p.requests.filter(r => r.step === 'webtoon-page-brief').map(r => JSON.parse(r.messages.at(-1).content));
const hashes = w => w.pages.map(p => p.image?.hash ?? null);
/** Start with `pages` pages, approve, and pass every page; resolves to the completed result. */
async function completed(pages, options = {}) {
  const { store, args } = await episodeSetup(), p = drawing({ pages, ...options });
  const first = await driveToImage(store, args, p);
  return { store, args, p, done: await passAll(store, first, p), first };
}

test('pages are drawn in order and a passed page feeds the next', async () => {
  const { store, args } = await episodeSetup(), p = drawing({ pages: 2 });
  const first = await driveToImage(store, args, p), [job] = first.jobs;
  assert.equal(first.status, 'needs_page_image'); assert.equal(job.kind, 'page');
  assert.equal(job.index, 1); assert.equal(job.total, 2); assert.equal(job.pageId, 'page-1');
  assert.equal(job.referenceImages.some(r => r.id === 'previous-page'), false);
  assert.match(job.prompt, /Page 1 of 2/); assert.equal(job.quality, null); assert.equal(job.apiRequest.model, 'gpt-image-2.5-sunburst');
  // Asking again changes nothing and issues the identical job: no image call is made or re-sent by the server.
  const again = await tool(store, {}, p);
  assert.equal(again.jobs[0].inputHash, job.inputHash); assert.equal(again.pages[0].image, null);
  const next = await importPageAndPass(store, job, p);
  assert.equal(next.jobs[0].index, 2); assert.equal(next.jobs[0].pageId, 'page-2');
  const w = await saved(store);
  assert.equal(w.pages[0].review.passed, true); assert.equal(w.pages[0].stage, 'passed');
  const previous = next.jobs[0].referenceImages.at(-1);
  assert.equal(previous.id, 'previous-page'); assert.equal(previous.hash, w.pages[0].image.hash); assert.equal(previous.path, w.pages[0].image.path);
  assert.deepEqual(briefRequests(p).map(d => d.pageNumber), [1, 2]);
});

test('the job references follow the prompt Image lines, previous page last', async () => {
  const { store, args } = await episodeSetup(), p = drawing({ pages: 2 });
  const next = await importPageAndPass(store, (await driveToImage(store, args, p)).jobs[0], p);
  const [job] = next.jobs, lines = [...job.prompt.matchAll(/^Image (\d+): (.*)$/gm)];
  assert.deepEqual(job.referenceImages.map(r => r.id), ['ref', 'previous-page']);
  assert.equal(lines.length, job.referenceImages.length);
  job.referenceImages.forEach((r, i) => { assert.equal(Number(lines[i][1]), i + 1); assert.ok(lines[i][2].startsWith(r.description)); });
});

test('the page image size comes from the stored bytes and the tiles job derives from it', async () => {
  const { store, args } = await episodeSetup(), p = drawing();
  const { jobs: [job] } = await driveToImage(store, args, p);
  const drawn = await importPage(store, job, p, { size: { width: 800, height: 1200 } });
  const [tiles] = drawn.jobs, w = await saved(store), image = w.pages[0].image;
  assert.deepEqual([image.width, image.height], [800, 1200]);
  assert.deepEqual(pngSize(await readFile(image.path)), { width: 800, height: 1200 });
  assert.equal(drawn.status, 'needs_page_tiles'); assert.equal(tiles.kind, 'page-tiles'); assert.equal(tiles.imageHash, image.hash);
  assert.equal(tiles.image, image.path); assert.equal(tiles.scale, 2); assert.equal(tiles.rects.length, 8);
  assert.equal(tiles.rects[0].id, 't-r1c1'); assert.ok(tiles.rects.every(r => r.x + r.w <= 800 && r.y + r.h <= 1200));
  assert.equal(image.provenance.requestedModel, 'gpt-image-2.5-sunburst');
});

test('a stale input hash, a wrong page and an unexpected stage are refused', async () => {
  const { store, args } = await episodeSetup(), p = drawing({ pages: 2 });
  const { jobs: [job] } = await driveToImage(store, args, p);
  await assert.rejects(importPage(store, job, p, { inputHash: digest('old job') }), /PAGE_IMAGE_INPUT_STALE/);
  await assert.rejects(importPage(store, job, p, { pageId: 'page-2' }), /PAGE_ID_MISMATCH/);
  await assert.rejects(importPage(store, job, p, { provenance: { kind: 'openai-api', requestedModel: 'other-model', selectionId: 'selected-api' } }), /IMAGE_EXECUTION_PROVENANCE_REQUIRED/);
  await assert.rejects(importPage(store, job, p, { bytes: Buffer.from('not an image at all, but long enough') }), /UNSUPPORTED_IMAGE/);
  assert.equal((await saved(store)).pages[0].image, null);
  const drawn = await importPage(store, job, p);
  await assert.rejects(importPage(store, job, p), /PAGE_IMAGE_NOT_EXPECTED/);
  assert.equal(drawn.status, 'needs_page_tiles');
});

test('a page brief written for something else is asked again before any image job', async () => {
  const { store, args } = await episodeSetup(), p = drawing();
  const { jobs: [job] } = await driveToImage(store, args, p);
  const w = await saved(store); w.pages[0].brief.subjectHash = digest('older adaptation'); await new WebtoonStore(store).save(w);
  await assert.rejects(importPage(store, job, p), /PAGE_BRIEF_REQUIRED/);
  const again = await tool(store, {}, p);
  assert.equal(briefRequests(p).length, 2); assert.equal(again.status, 'needs_page_image'); assert.equal(again.jobs.length, 1);
  assert.notEqual(again.pages[0].brief.subjectHash, digest('older adaptation'));
  assert.equal((await saved(store)).events.some(e => e.event === 'page_brief_stale'), true);
});

test('tiles bound to another image are refused', async () => {
  const { store, args } = await episodeSetup(), p = drawing();
  const { jobs: [job] } = await driveToImage(store, args, p);
  const { jobs: [tiles] } = await importPage(store, job, p);
  await assert.rejects(importTiles(store, tiles, p, { over: { imageHash: digest(pngOf(10, 10)) } }), /PAGE_TILES_STALE/);
  await assert.rejects(importTiles(store, tiles, p, { over: { pageId: 'page-2' } }), /PAGE_ID_MISMATCH/);
  assert.equal((await saved(store)).pages[0].tiles, null);
  const reviewed = await importTiles(store, tiles, p);
  assert.equal(reviewed.status, 'completed');
});

test('tile sizes and hashes are derived from the files, and missing or wrong tiles are refused', async () => {
  const { store, args } = await episodeSetup(), p = drawing();
  const { jobs: [job] } = await driveToImage(store, args, p);
  const { jobs: [tiles] } = await importPage(store, job, p);
  await assert.rejects(importTiles(store, tiles, p, { sizeOf: r => ({ width: r.w, height: r.h }) }), /PAGE_TILE_SIZE/);
  await assert.rejects(importTiles(store, { ...tiles, rects: tiles.rects.slice(1) }, p), /PAGE_TILES_INCOMPLETE/);
  await assert.rejects(importTiles(store, { ...tiles, rects: [...tiles.rects.slice(1), { ...tiles.rects[1], id: 't-r9c9' }] }, p), /INVALID_ASSET_SHOT/);
  assert.equal((await saved(store)).stage, 'needs_page_tiles');
  await importTiles(store, tiles, p);
  const w = await saved(store);
  for (const tile of w.pages[0].tiles) {
    const bytes = await readFile(tile.path);
    assert.equal(tile.hash, digest(bytes)); assert.deepEqual({ width: tile.width, height: tile.height }, pngSize(bytes));
  }
  assert.equal(w.pages[0].tiles.length, 8);
});

test('the page review request carries the page, 8 tiles, the previous page, then the references', async () => {
  const { store, args } = await episodeSetup(), p = drawing({ pages: 2 });
  const next = await importPageAndPass(store, (await driveToImage(store, args, p)).jobs[0], p);
  await importPage(store, next.jobs[0], p);
  const w = await saved(store);
  const { jobs: [tiles] } = await tool(store, {}, p);
  await importTiles(store, tiles, p);
  const requests = p.requests.filter(r => r.step === 'webtoon-page-review'), second = requests.at(-1), data = JSON.parse(second.messages.at(-1).content);
  assert.equal(second.images.length, 1 + 8 + 1 + 1);
  assert.equal(second.images[0].path, (await saved(store)).pages[1].image.path);
  assert.deepEqual(data.referenceImages.map(r => r.id), ['current-page', ...w.pages[1].tiles?.map(t => t.id) ?? ['t-r1c1', 't-r1c2', 't-r2c1', 't-r2c2', 't-r3c1', 't-r3c2', 't-r4c1', 't-r4c2'], 'previous-page', 'ref']);
  assert.equal(second.images[9].path, w.pages[0].image.path);
  assert.deepEqual(Object.keys(data.schema.previousPage).sort(), ['clothing', 'identity', 'props', 'transition']);
  assert.equal(JSON.parse(requests[0].messages.at(-1).content).schema.previousPage, undefined);
});

test('a failed page is never a reference and stops after its budget', async () => {
  const { store, args } = await episodeSetup(), p = drawing({ pages: 3, pageReview: (d, calls) => d.page.id === 'page-2' ? { wrongText: '엉뚱한 글자' } : undefined });
  const second = await importPageAndPass(store, (await driveToImage(store, args, p)).jobs[0], p);
  assert.equal(second.jobs[0].pageId, 'page-2');
  // The first review of page 2 fails: it is redrawn once (budget 1), still without its own failed image as a reference.
  const redraw = await importPageAndPass(store, second.jobs[0], p);
  assert.equal(redraw.status, 'needs_page_image'); assert.equal(redraw.jobs[0].pageId, 'page-2');
  assert.deepEqual(redraw.jobs[0].referenceImages.map(r => r.id), ['ref', 'previous-page']);
  const failedImage = (await saved(store)).pages[1].attempts[0].imageHash;
  assert.ok(!redraw.jobs[0].referenceImages.some(r => r.hash === failedImage));
  const redrawFeedback = briefRequests(p).at(-1).feedback;
  assert.match(redrawFeedback, /text t2-1-1 must read ".*" but the tiles showed "엉뚱한 글자"/);
  assert.deepEqual(briefRequests(p).at(-1).page.id, 'page-2'); assert.ok(redraw.pages[1].brief.renderBrief.corrections.length);
  const stopped = await importPageAndPass(store, redraw.jobs[0], p);
  assert.equal(stopped.status, 'page_needs_revision'); assert.equal(stopped.jobs, undefined);
  assert.match(stopped.nextAction, /page-?|redraw|pageIds/i);
  const w = await saved(store);
  assert.equal(w.pages[1].attempts.length, 2); assert.equal(w.pages[1].review.passed, false); assert.equal(w.pages[1].revision, 1);
  assert.equal(w.pages[2].stage, 'pending'); assert.equal(w.pages[2].brief, null); assert.equal(w.pages[2].image, null);
  assert.equal(briefRequests(p).filter(d => d.page.id === 'page-3').length, 0);
  // Asking again does not draw or review anything more.
  const calls = p.requests.length; assert.equal((await tool(store, {}, p)).status, 'page_needs_revision'); assert.equal(p.requests.length, calls);
});

test('the redraw feedback lists failed panel delivery, failed visual checks and blocking findings as corrections', async () => {
  const { store, args } = await episodeSetup(), p = drawing({ pageReview: (d, calls) => calls === 1 ? { wrongText: '다른 글자' } : undefined });
  const base = p.complete.bind(p);
  p.complete = async request => {
    const response = await base(request);
    if (request.step !== 'webtoon-page-review' || p.reviews['page-1'] !== 1) return response;
    const value = JSON.parse(response.text);
    value.panelDelivery[1].status = 'missing'; value.visualChecks.handsAndContact = { status: 'failed', panels: [1], evidence: 'The hand fuses with the door.' };
    value.findings = [{ severity: 'blocking', evidence: 'A third speaker appears in panel 2.' }, { severity: 'advisory', evidence: 'Soft lighting.' }];
    return { text: JSON.stringify(value) };
  };
  const { jobs: [job] } = await driveToImage(store, args, p);
  await importPageAndPass(store, job, p);
  const feedback = briefRequests(p).at(-1).feedback;
  assert.match(feedback, /panel p1-2 must show: .* \(missing: Drawn in the page\.\)/);
  assert.match(feedback, /handsAndContact \(failed\) \[panels: 1\]: The hand fuses with the door\./);
  assert.match(feedback, /A third speaker appears in panel 2\./);
  assert.doesNotMatch(feedback, /Soft lighting/);
});

test('a blocked page brief issues no image job and can be revised', async () => {
  const { store, args } = await episodeSetup(), p = drawing({ pageBrief: 'block' });
  const r = await driveToImage(store, args, p);
  assert.equal(r.status, 'page_brief_blocked'); assert.equal(r.jobs, undefined); assert.equal(r.pages[0].brief.passed, false);
  assert.match(r.nextAction, /revise/); assert.equal((await tool(store, {}, p)).status, 'page_brief_blocked');
  const revised = await tool(store, { action: 'revise', target: 'page', pageIds: ['page-1'], feedback: '문 앞 장면을 더 단순하게' }, p);
  assert.equal(revised.status, 'page_brief_blocked'); assert.match(briefRequests(p).at(-1).feedback, /더 단순하게/);
});

test('page revise resets only that page and later dependants', async () => {
  const { store, p, done } = await completed(3);
  assert.equal(done.status, 'completed');
  const before = await saved(store), keptHash = before.pages[0].image.hash;
  const revised = await tool(store, { action: 'revise', target: 'page', pageIds: ['page-2'], feedback: '둘째 쪽의 표정을 더 크게' }, p);
  const w = await saved(store);
  assert.equal(w.revision, before.revision + 1); assert.equal(revised.status, 'needs_page_image');
  assert.equal(w.pages[0].image.hash, keptHash); assert.equal(w.pages[0].review.passed, true); assert.equal(w.pages[0].tiles.length, 8);
  for (const i of [1, 2]) { assert.equal(w.pages[i].image, null); assert.equal(w.pages[i].review, null); assert.equal(w.pages[i].tiles, null); }
  assert.equal(w.pages[1].attempts.at(-1).failedAt, 'user_revision'); assert.equal(w.pages[1].attempts.at(-1).imageHash, before.pages[1].image.hash);
  assert.equal(w.pages[2].feedback, undefined); assert.equal(w.productionRecordHash, undefined); assert.equal(w.stage, 'needs_page_image');
  assert.equal(revised.jobs[0].pageId, 'page-2'); assert.match(briefRequests(p).at(-1).feedback, /표정을 더 크게/);
  assert.equal(revised.jobs[0].referenceImages.at(-1).hash, keptHash);
  // The redraw budget is fresh for a revised page.
  assert.equal(w.pages[1].revision, 0);
  const again = await passAll(store, revised, p);
  assert.equal(again.status, 'completed'); assert.notEqual((await saved(store)).pages[1].image.hash, before.pages[1].image.hash);
});

test('page revise needs approved pages, known page ids and the user words', async () => {
  const { store, args } = await episodeSetup(), p = drawing({ pages: 2 });
  const gate = await tool(store, args, p);
  await assert.rejects(tool(store, { action: 'revise', target: 'page', pageIds: ['page-1'], feedback: 'x' }, p), /EPISODE_PAGE_REVISE_UNAVAILABLE/);
  await tool(store, { action: 'approve', approvalId: gate.approvalView.approvalId, feedback: '좋아요' }, p);
  await assert.rejects(tool(store, { action: 'revise', target: 'page', pageIds: ['page-1'] }, p), /EPISODE_REVISION_FEEDBACK_REQUIRED/);
  for (const pageIds of [undefined, [], ['page-9'], ['page-1', 'page-1']]) await assert.rejects(tool(store, { action: 'revise', target: 'page', pageIds, feedback: 'x' }, p), /INVALID_EPISODE_PAGE_IDS/);
});

/** Adaptation answer whose third page differs from the base only in what its first panel shows. */
const changePage = (index, shows) => (d, base) => { const next = structuredClone(base); next.pages[index].panels[0].shows = shows; return next; };

test('adaptation revise keeps unchanged leading pages', async () => {
  const { store, p, done } = await completed(3);
  assert.equal(done.status, 'completed');
  const before = await saved(store), draw = before.pages.map(pg => pg.image.hash);
  const reshaped = drawing({ pages: 3, adaptation: changePage(2, '문이 열리며 새어 나오는 불빛') });
  Object.assign(p, { complete: reshaped.complete, requests: reshaped.requests });
  const gate = await tool(store, { action: 'revise', target: 'adaptation', feedback: '셋째 쪽의 첫 칸을 불빛으로 바꿔 주세요.' }, p);
  // Nothing is drawn before the new adaptation is approved, and the old approval is not usable.
  assert.equal(gate.status, 'awaiting_adaptation_approval'); assert.equal(gate.jobs, undefined); assert.deepEqual(gate.pages, []);
  assert.equal(p.requests.some(r => r.step === 'webtoon-page-brief'), false);
  await assert.rejects(tool(store, { action: 'approve', approvalId: before.approvalId, feedback: '좋아요' }, p), /ADAPTATION_APPROVAL_STALE/);
  const next = await tool(store, { action: 'approve', approvalId: gate.approvalView.approvalId, feedback: '이대로' }, p);
  const w = await saved(store);
  assert.deepEqual(w.pages.slice(0, 2).map(pg => pg.image.hash), draw.slice(0, 2));
  assert.deepEqual(w.pages.slice(0, 2).map(pg => pg.review.passed), [true, true]);
  assert.equal(w.pages[2].image, null); assert.equal(w.pages[2].review, null); assert.notEqual(w.pages[2].digest, before.pages[2].digest);
  assert.equal(w.keptPages, undefined);
  // The next job is page 3 and draws beside the kept page 2.
  assert.equal(next.status, 'needs_page_image'); assert.equal(next.jobs[0].pageId, 'page-3'); assert.equal(next.jobs[0].index, 3);
  assert.equal(next.jobs[0].referenceImages.at(-1).hash, draw[1]);
  assert.equal(p.requests.filter(r => r.step === 'webtoon-page-brief').length, 1);
  const finished = await passAll(store, next, p);
  assert.equal(finished.status, 'completed');
  const after = await saved(store); assert.deepEqual(after.pages.slice(0, 2).map(pg => pg.image.hash), draw.slice(0, 2)); assert.notEqual(after.pages[2].image.hash, draw[2]);
  assert.notEqual(after.productionRecordHash, before.productionRecordHash);
});

test('adaptation revise resets the first changed page and everything after it', async () => {
  const { store, p, done } = await completed(3);
  assert.equal(done.status, 'completed');
  const before = await saved(store), reshaped = drawing({ pages: 3, adaptation: changePage(1, '창문 너머의 낯선 그림자') });
  Object.assign(p, { complete: reshaped.complete, requests: reshaped.requests });
  const gate = await tool(store, { action: 'revise', target: 'adaptation', feedback: '둘째 쪽을 바꿔 주세요.' }, p);
  const next = await tool(store, { action: 'approve', approvalId: gate.approvalView.approvalId, feedback: '이대로' }, p);
  const w = await saved(store);
  assert.equal(w.pages[0].image.hash, before.pages[0].image.hash);
  // Page 3 is unchanged in content, but it follows a changed page: it is not kept.
  assert.equal(w.pages[1].image, null); assert.equal(w.pages[2].image, null); assert.equal(w.pages[2].digest, before.pages[2].digest);
  assert.equal(next.jobs[0].pageId, 'page-2');
});

test('an adaptation revise that changes page 1 keeps nothing, and one that changes nothing keeps everything', async () => {
  const { store, p } = await completed(2);
  const before = await saved(store);
  // Same adaptation again: every page is kept, so the episode completes again without a page brief or image job.
  const same = drawing({ pages: 2 });
  Object.assign(p, { complete: same.complete, requests: same.requests });
  const gate = await tool(store, { action: 'revise', target: 'adaptation', feedback: '그대로 다시 확인' }, p);
  const redone = await tool(store, { action: 'approve', approvalId: gate.approvalView.approvalId, feedback: '이대로' }, p);
  assert.equal(redone.status, 'completed'); assert.deepEqual(hashes(await saved(store)), hashes(before));
  assert.equal(same.requests.some(r => ['webtoon-page-brief', 'webtoon-page-review'].includes(r.step)), false);
  assert.notEqual((await saved(store)).productionRecordHash, before.productionRecordHash);
  const reshaped = drawing({ pages: 2, adaptation: changePage(0, '문손잡이를 쥔 손') });
  Object.assign(p, { complete: reshaped.complete, requests: reshaped.requests });
  const gate2 = await tool(store, { action: 'revise', target: 'adaptation', feedback: '첫 쪽을 바꿔 주세요.' }, p);
  const next = await tool(store, { action: 'approve', approvalId: gate2.approvalView.approvalId, feedback: '이대로' }, p);
  assert.deepEqual(hashes(await saved(store)), [null, null]); assert.equal(next.jobs[0].pageId, 'page-1');
});

test('an adaptation revise before approval keeps nothing to keep and draws nothing', async () => {
  const { store, args } = await episodeSetup(), p = drawing({ pages: 2 });
  await tool(store, args, p);
  const revised = await tool(store, { action: 'revise', target: 'adaptation', feedback: '더 천천히' }, p);
  assert.equal(revised.status, 'awaiting_adaptation_approval'); assert.equal(revised.jobs, undefined); assert.equal((await saved(store)).keptPages, undefined);
});

test('completion writes the page files, episode.html and a production record; verify detects a changed page image', async () => {
  const { store, p, done } = await completed(2);
  assert.equal(done.status, 'completed'); assert.equal(done.jobs, undefined);
  const w = await saved(store);
  for (const name of ['page-01.png', 'page-02.png', 'episode.html']) assert.ok(done.artifacts[name], name);
  assert.deepEqual(await readFile(done.artifacts['page-02.png'].path), await readFile(w.pages[1].image.path));
  const html = await readFile(done.artifacts['episode.html'].path, 'utf8');
  assert.match(html, /^<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport"/); assert.equal(html.match(/<img src="data:image\/png;base64,/g).length, 2);
  assert.match(html, /episode-pages-v1/); assert.match(html, /<h1>문 앞의 망설임<\/h1>/);
  const recordFile = join(store.rootDir, '.vibelore', 'productions', `${w.workflowId}-r${w.revision}.json`);
  const record = JSON.parse(await readFile(recordFile, 'utf8'));
  assert.equal(digest(record), w.productionRecordHash); assert.equal(done.productionRecordHash, w.productionRecordHash);
  assert.equal(record.kind, 'webtoon-episode'); assert.equal(record.source.hash, w.source.hash); assert.equal(record.adaptation.hash.startsWith('sha256:'), true);
  assert.equal(record.adaptation.independence, 'same-host'); assert.equal(record.adaptation.approval.by, 'user');
  assert.deepEqual(record.pages.map(pg => pg.id), ['page-1', 'page-2']);
  w.pages.forEach((state, i) => {
    const page = record.pages[i];
    assert.equal(page.image.hash, state.image.hash); assert.equal(page.image.requestedModel, 'gpt-image-2.5-sunburst'); assert.equal(page.image.requestedQuality, null);
    assert.deepEqual(page.tiles.map(t => t.hash), state.tiles.map(t => t.hash)); assert.equal(page.review.hash, digest(state.review)); assert.equal(page.review.independence, 'same-host');
    assert.ok(!page.image.path.startsWith('/'));
  });
  assert.ok((await readdir(join(store.rootDir, '.vibelore', 'productions'))).includes(`${w.workflowId}-r${w.revision}.json`));
  const verified = await tool(store, { action: 'verify' }, p);
  assert.equal(verified.status, 'verified'); assert.deepEqual(verified.mismatches, []);
  assert.equal(verified.checks.filter(c => c.check === 'page-image').length, 2); assert.equal(verified.checks.filter(c => c.check === 'page-tile').length, 16);
  assert.equal(verified.recordHash, w.productionRecordHash);
  // Overwriting a stored page image is reported with the page, the path and both hashes; the read-only verify changes nothing.
  await writeFile(w.pages[1].image.path, pngOf(PAGE_SIZE.width, PAGE_SIZE.height));
  const changed = await tool(store, { action: 'verify' }, p);
  assert.equal(changed.status, 'mismatch');
  assert.deepEqual(changed.mismatches.map(m => [m.check, m.pageId]), [['page-image', 'page-2']]);
  assert.equal(changed.mismatches[0].hash, w.pages[1].image.hash); assert.notEqual(changed.mismatches[0].actual, w.pages[1].image.hash);
  assert.equal((await saved(store)).stage, 'completed');
});

test('verify reports a changed tile and a missing page image', async () => {
  const { store, p } = await completed(1);
  const w = await saved(store);
  await writeFile(w.pages[0].tiles[3].path, pngOf(10, 10));
  const tile = await tool(store, { action: 'verify' }, p);
  assert.deepEqual(tile.mismatches.map(m => [m.check, m.tileId]), [['page-tile', w.pages[0].tiles[3].id]]);
  await rm(w.pages[0].image.path);
  const gone = await tool(store, { action: 'verify' }, p);
  assert.ok(gone.mismatches.some(m => m.check === 'page-image' && m.actual === null));
});

test('verify during the page loop reports the pages drawn so far', async () => {
  const { store, args } = await episodeSetup(), p = drawing({ pages: 2 });
  await importPageAndPass(store, (await driveToImage(store, args, p)).jobs[0], p);
  const v = await tool(store, { action: 'verify' }, p);
  assert.equal(v.status, 'verified'); assert.equal(v.stage, 'needs_page_image');
  assert.equal(v.checks.filter(c => c.check === 'page-image').length, 1);
});

test('requested quality is carried in the job and recorded in provenance', async () => {
  const { store, args } = await episodeSetup();
  await runConfigureStatus({ store, workId, webtoonImageQuality: 'high' });
  const p = drawing();
  const first = await driveToImage(store, args, p), [job] = first.jobs;
  assert.equal(job.quality, 'high'); assert.equal(first.imageQuality, 'high');
  await assert.rejects(importPage(store, job, p, { provenance: { ...provenanceFor(job), requestedQuality: 'ultra' } }), /INVALID_IMAGE_QUALITY/);
  const drawn = await importPage(store, job, p);
  assert.equal((await saved(store)).pages[0].image.provenance.requestedQuality, 'high');
  const done = await importTiles(store, drawn.jobs[0], p);
  const w = await saved(store), record = JSON.parse(await readFile(join(store.rootDir, '.vibelore', 'productions', `${w.workflowId}-r${w.revision}.json`), 'utf8'));
  assert.equal(done.status, 'completed'); assert.equal(record.imageQuality, 'high'); assert.equal(record.pages[0].image.requestedQuality, 'high');
});

test('the quality snapshotted at start does not change when the work setting changes later', async () => {
  const { store, args } = await episodeSetup();
  await runConfigureStatus({ store, workId, webtoonImageQuality: 'low' });
  const p = drawing({ pages: 2 }), first = await driveToImage(store, args, p);
  await runConfigureStatus({ store, workId, webtoonImageQuality: 'high' });
  const next = await importPageAndPass(store, first.jobs[0], p);
  assert.equal(first.jobs[0].quality, 'low'); assert.equal(next.jobs[0].quality, 'low');
});

test('an invalid page review stops at model_failed and retry asks the reviewer again without re-sending an image job', async () => {
  const { store, args } = await episodeSetup(), p = drawing();
  const { jobs: [job] } = await driveToImage(store, args, p);
  const { jobs: [tiles] } = await importPage(store, job, p);
  const base = p.complete.bind(p); let broken = true;
  p.complete = async request => {
    const response = await base(request);
    if (request.step !== 'webtoon-page-review' || !broken) return response;
    const value = JSON.parse(response.text); value.panelDelivery = value.panelDelivery.slice(1); return { text: JSON.stringify(value) };
  };
  await assert.rejects(importTiles(store, tiles, p), /INCOMPLETE_PAGE_DELIVERY/);
  const failed = await saved(store);
  assert.equal(failed.stage, 'model_failed'); assert.equal(failed.failedStage, 'page_review'); assert.equal(failed.pages[0].image.hash, failed.pages[0].image.hash);
  broken = false;
  const done = await tool(store, { action: 'retry' }, p);
  assert.equal(done.status, 'completed'); assert.equal(p.requests.filter(r => r.step === 'webtoon-page-review').length, 2);
});

test('a delegated approval draws pages with the same loop and records the delegation', async () => {
  const { store, args } = await episodeSetup(), p = drawing();
  const r = await tool(store, { ...args, delegation: { scope: 'production', userAnswer: '알아서 만들어 주세요', apiPolicy: 'existing-only' } }, p);
  assert.equal(r.approval.by, 'delegated'); assert.equal(r.status, 'needs_page_image'); assert.equal(r.jobs[0].pageId, 'page-1');
  const done = await passAll(store, r, p);
  assert.equal(done.status, 'completed');
  const w = await saved(store), record = JSON.parse(await readFile(join(store.rootDir, '.vibelore', 'productions', `${w.workflowId}-r${w.revision}.json`), 'utf8'));
  assert.equal(record.adaptation.approval.by, 'delegated'); assert.equal(record.delegation.scope, 'production');
});

test('with API calls forbidden no page is planned or drawn', async () => {
  const { store, args } = await episodeSetup(), p = drawing();
  const r = await tool(store, { ...args, delegation: { scope: 'production', userAnswer: '알아서', apiPolicy: 'forbid' } }, p);
  assert.equal(r.status, 'needs_image_runtime'); assert.deepEqual(r.jobs, []); assert.equal(p.requests.length, 0);
});

test('host relay answers the page brief and the page review with the configured reviewer pinned', async () => {
  const { store, args } = await episodeSetup();
  await runConfigureStatus({ store, workId, webtoonReviewModel: { provider: 'host', modelId: 'page-reviewer' } });
  const p = provider(), gate = await tool(store, args, p);
  let r = await tool(store, { action: 'approve', approvalId: gate.approvalView.approvalId, feedback: '이대로' }, createHostRelay());
  const resume = async (result, answer) => { const run = await loadRun(store.rootDir, result.runId), q = result.requests[0];
    return runWebtoonEpisodeTool({ store, args: run.args, run, providers: createHostRelay({ [q.id]: JSON.stringify(answer(JSON.parse(q.user), q)) }) }); };
  assert.equal(r.requests[0].step, 'webtoon-page-brief'); assert.equal(r.requests[0].model, undefined);
  r = await resume(r, d => pageBriefAnswer(d));
  assert.equal(r.status, 'needs_page_image'); assert.equal(r.jobs.length, 1);
  const { jobs: [tiles] } = await importPage(store, r.jobs[0], createHostRelay());
  r = await importTiles(store, tiles, createHostRelay());
  assert.equal(r.status, 'needs_model'); assert.equal(r.requests[0].step, 'webtoon-page-review'); assert.equal(r.requests[0].model.modelId, 'page-reviewer');
  r = await resume(r, d => pageReviewAnswer(d));
  assert.equal(r.status, 'completed'); assert.equal((await saved(store)).pages[0].review.independence, 'configured-model');
  assert.equal((await saved(store)).pages[0].review.model.modelId, 'page-reviewer');
});
