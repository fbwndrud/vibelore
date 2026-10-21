import { test } from "node:test";
import assert from "node:assert/strict";
import { withAudioScene } from "./helpers/project.js";
import { googleHttp, interaction } from "./helpers/google-http.js";
import { wav } from "./helpers/images.js";
import { googleProvider } from "../src/providers/google.js";
import { runWorker } from "../src/engine/worker.js";
import { Drafts } from "../ui/api.js";
import { renderAssetLab } from "../ui/asset-lab.js";
import { renderEdit } from "../ui/edit.js";

// Small event/DOM boundary, not a duplicate of a workspace's rendering or command logic.
// Tests call the actual component and actual form submit listeners against the engine.
class Element {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.listeners = {};
    this.attributes = {};
    this._value = undefined;
    this.isConnected = false;
    this.multiple = false;
    this.selected = false;
    this.required = false;
    this.disabled = false;
    this.dataset = {};
  }
  setAttribute(name, value) {
    this.attributes[name] = value;
    this[name] = value;
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  append(...children) {
    for (const child of children) {
      this.children.push(child);
      child.parent = this;
    }
  }
  replaceChildren(...children) {
    this.children = [];
    this.append(...children);
  }
  get value() {
    return (
      this._value ??
      (this.tag === "select"
        ? (this.children.find((x) => x.selected)?.value ??
          this.children[0]?.value ??
          "")
        : "")
    );
  }
  set value(v) {
    this._value = String(v);
  }
  get textContent() {
    return (
      (this._text ?? "") + this.children.map((x) => x.textContent).join("")
    );
  }
  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }
  dispatchEvent(event) {
    const delivered = { preventDefault() {}, target: this };
    for (let node = this; node; node = event.bubbles ? node.parent : null)
      for (const fn of node.listeners[event.type] ?? []) fn(delivered);
    return true;
  }
  async fire(type) {
    for (const fn of this.listeners[type] ?? [])
      await fn({ preventDefault() {}, target: this });
  }
}
const tree = (node) => [node, ...node.children.flatMap(tree)];
const named = (root, name) => tree(root).find((x) => x.name === name);
const submitForm = (root, label) => {
  const button = tree(root).find(
    (x) => x.tag === "button" && x.textContent === label,
  );
  assert.ok(button, `Rendered action: ${label}`);
  let parent = button.parent;
  while (parent?.tag !== "form") parent = parent.parent;
  return parent;
};
async function context(t, f) {
  const previous = { Node: globalThis.Node, document: globalThis.document };
  globalThis.Node = Element;
  globalThis.document = {
    createElement: (tag) => new Element(tag),
    createTextNode: (text) => {
      const n = new Element("#text");
      n.textContent = text;
      return n;
    },
  };
  t.after(() => {
    globalThis.Node = previous.Node;
    globalThis.document = previous.document;
  });
  const c = {
    snapshot: await f.service.snapshot("p1"),
    selection: { scene: "scene", utterance: "u1", shot: "shot" },
    drafts: new Drafts(),
    urls: new Set(),
    sent: [],
    persist() {},
    status() {},
    render() {},
    run: (fn) => fn(),
    api: {
      bootstrap: {
        providers: [await f.service.providers.google?.capabilities?.()].filter(
          Boolean,
        ),
      },
      blob: async () => "blob:fixture",
    },
    async send(envelope) {
      this.sent.push(envelope);
      return f.service.command(envelope);
    },
    async refresh() {
      this.snapshot = await f.service.snapshot("p1");
    },
  };
  return c;
}

test("rendered Asset Lab generates and adopts first selected-utterance take without importing WAV or creating a slot first", async (t) => {
  const f = await withAudioScene(t);
  await f.command(
    "casting.set",
    {
      id: "childcast",
      scope: "project",
      roleId: "actor",
      state: "childvoice",
      voice: "Kore",
    },
    { aggregate: { kind: "casting", id: "childcast" } },
  );
  const http = await googleHttp(t, () =>
    interaction(
      [
        {
          type: "audio",
          mime_type: "audio/wav",
          data: wav().toString("base64"),
        },
      ],
      { model: "gemini-3.8-flash-tts" },
    ),
  );
  f.service.providers.google = googleProvider({
    key: "component-test-only",
    baseURL: http.baseURL,
  });
  const c = await context(t, f);
  assert.equal(c.snapshot.slots.length, 0);
  let root = renderAssetLab(c);
  const mode = tree(root).find(
    (x) => x.tag === "select" && x.children.some((o) => o.value === "audio"),
  );
  assert.ok(mode, "actual rendered mode allows first audio generation");
  mode.value = "audio";
  await mode.fire("change");
  root = renderAssetLab(c);
  const generate = submitForm(root, "예약하고 후보 요청");
  named(generate, "estimate").value = "0.01";
  await generate.fire("submit");
  assert.equal(c.sent.at(-1).payload.kind, "audio");
  assert.deepEqual(c.sent.at(-1).payload.target, {
    kind: "utterance",
    id: "u1",
  });
  assert.equal((await f.service.snapshot("p1")).slots.length, 0);
  await runWorker({ service: f.service, drain: true });
  await c.refresh();
  assert.equal(http.calls.length, 1);
  assert.equal(http.calls[0].body.input[0].content[0].text, "같은 대사");
  root = renderAssetLab(c);
  let adopt = submitForm(root, "후보 채택");
  named(adopt, "reason").value = "발화와 목소리 후보를 검토함";
  await adopt.fire("input");
  root = renderAssetLab(c);
  adopt = submitForm(root, "후보 채택");
  assert.equal(named(adopt, "reason").value, "발화와 목소리 후보를 검토함");
  await adopt.fire("submit");
  const slot = c.snapshot.slots[0];
  assert.equal(slot.mediaKind, "audio");
  assert.equal(slot.utteranceId, "u1");
  assert.equal(slot.castingStateRef, "childvoice");
  assert.deepEqual(slot.subject, { kind: "role", id: "actor" });
  assert.equal(slot.candidateId, c.snapshot.candidates[0].id);
  assert.equal(c.selection.slot, slot.id);
  assert.equal(
    c.snapshot.slots.some((x) => x.utteranceId === "u2"),
    false,
  );
  // A subsequent actual form request targets the adopted slot and keeps its identity.
  root = renderAssetLab(c);
  const nextGenerate = submitForm(root, "예약하고 후보 요청");
  named(nextGenerate, "estimate").value = "0.01";
  await nextGenerate.fire("submit");
  assert.deepEqual(c.sent.at(-1).payload.target, {
    kind: "assetSlot",
    id: slot.id,
  });
  await runWorker({ service: f.service, drain: true });
  await c.refresh();
  assert.equal(http.calls.length, 2);
  root = renderAssetLab(c);
  await submitForm(root, "후보 채택").fire("submit");
  assert.equal(c.snapshot.slots.length, 1);
  assert.equal(c.snapshot.slots[0].id, slot.id);
  assert.notEqual(c.snapshot.slots[0].candidateId, slot.candidateId);
});

test("rendered Edit title save preserves four asymmetric safe-area insets; editing one edge changes only that edge", async (t) => {
  const f = await withAudioScene(t);
  const scene = (await f.service.snapshot("p1")).scenes[0];
  const insets = { left: 0.05, top: 0.1, right: 0.2, bottom: 0.3 };
  scene.shots[0].transform = {
    x: 0,
    y: 0,
    scale: 1,
    safeArea: insets,
    anchor: "center",
    easing: "linear",
    keyframes: [],
  };
  await f.command("scene.put", scene, {
    aggregate: { kind: "scene", id: "scene" },
  });
  const c = await context(t, f);
  let root = renderEdit(c);
  let form = submitForm(root, "샷 연출 저장");
  named(form, "title").value = "Changed title only";
  await form.fire("submit");
  assert.equal(tree(form).find((x) => x.role === "alert").textContent, "");
  assert.equal(c.snapshot.scenes[0].shots[0].title, "Changed title only");
  assert.deepEqual(c.snapshot.scenes[0].shots[0].transform.safeArea, insets);
  root = renderEdit(c);
  form = submitForm(root, "샷 연출 저장");
  const top = named(form, "safeAreaTop");
  assert.ok(top, "top edge has independent rendered control");
  top.value = "0.15";
  await form.fire("submit");
  assert.deepEqual(c.snapshot.scenes[0].shots[0].transform.safeArea, {
    ...insets,
    top: 0.15,
  });
});

test("Edit exposes actual frozen preview creation and aspect selection through common edition authority", async (t) => {
  const { audioFixture } = await import("./helpers/render-fixture.js");
  const f = await audioFixture(t);
  const c = await context(t, f);
  c.selection.production = "main";
  const root = renderEdit(c);
  const profile = named(root, "previewProfile");
  assert.ok(profile, "Aspect/audio selection");
  profile.value = "audio";
  await profile.fire("change");
  const create = tree(root).find(
    (x) => x.tag === "button" && x.textContent === "새 미리보기 고정",
  );
  assert.ok(create);
  await create.fire("click");
  const s = await f.service.snapshot("p1");
  assert.equal(s.editions.length, 1);
  assert.equal(s.editions[0].closure.profile.kind, "audio");
  assert.equal(c.sent.at(-1).type, "edition.create");
});

test("Edit hold-only form save does not add empty performance fields or invalidate accepted audio", async (t) => {
  const { audioFixture } = await import("./helpers/render-fixture.js");
  const f = await audioFixture(t),
    c = await context(t, f);
  c.selection.production = "main";
  const root = renderEdit(c);
  named(root, "holdMs").value = "1400";
  await submitForm(root, "이 발화 저장").fire("submit");
  const e = await f.command(
    "edition.create",
    { id: "after-hold", productionId: "main", profile: "audio" },
    { aggregate: { kind: "edition", id: "after-hold" } },
  );
  assert.equal(e.value.closure.timeline.takes[0].startSample, 67200);
});

test("rendered player records a fresh policy-bound review after rebinding and preserves the old receipt", async (t) => {
  const { audioFixture } = await import("./helpers/render-fixture.js");
  const { renderPreview } = await import("../ui/player.js");
  const f = await audioFixture(t);
  const e = (
    await f.command(
      "edition.create",
      { id: "v1", productionId: "main", profile: "audio" },
      { aggregate: { kind: "edition", id: "v1" } },
    )
  ).value;
  const out = (
    await f.command(
      "edition.render",
      { editionId: e.id, renderId: "r1" },
      { aggregate: { kind: "editionOutput", id: "r1" } },
    )
  ).value;
  const old = (
    await f.command(
      "edition.review",
      {
        id: "old",
        editionId: e.id,
        renderId: out.id,
        actor: "fixture",
        closureDigest: e.closureDigest,
        outputManifestDigest: out.manifestDigest,
        policyBindingRevision: 0,
        checks: { listened: true },
      },
      { aggregate: { kind: "editionReview", id: "old" } },
    )
  ).value;
  await f.command(
    "policy.create",
    { id: "updated", name: "Updated listening policy", required: ["listened"] },
    { aggregate: { kind: "reviewPolicy", id: "updated" } },
  );
  await f.command(
    "edition.bindPolicy",
    {
      editionId: e.id,
      policyId: "updated",
      reason: "New revision requires fresh review",
    },
    { aggregate: { kind: "editionPolicy", id: e.id } },
  );
  const c = await context(t, f);
  c.selection.production = "main";
  c.selection.edition = e.id;
  let root = renderPreview(c);
  assert.equal(
    tree(root).some(
      (x) => x.tag === "button" && x.textContent === "검토한 고정판 발행 기록",
    ),
    false,
    "stale review must not be offered for publication",
  );
  assert.match(root.textContent, /정책.*변경.*다시/);
  const form = submitForm(root, "내 감상 검토 기록");
  named(form, "listened").value = "yes";
  await form.fire("submit");
  assert.equal(tree(form).find((x) => x.role === "alert").textContent, "");
  assert.deepEqual(
    c.snapshot.editionReviews.find((r) => r.id === "old"),
    old,
  );
  const fresh = c.snapshot.editionReviews.find((r) => r.id !== "old");
  assert.ok(fresh);
  assert.equal(fresh.policyBindingRevision, 1);
  root = renderPreview(c);
  await tree(root)
    .find(
      (x) => x.tag === "button" && x.textContent === "검토한 고정판 발행 기록",
    )
    .fire("click");
  assert.equal(c.snapshot.editionPublications[0].reviewId, fresh.id);
});

test('Production backup and fresh restore actions use common engine and preserve source project',async t=>{
  const {withStudio}=await import('./helpers/project.js');
  const {renderProduction}=await import('../ui/production.js');
  const {access}=await import('node:fs/promises');const {join}=await import('node:path');
  const f=await withStudio(t),c=await context(t,f);
  let root=renderProduction(c);
  const save=tree(root).find(x=>x.tag==='button'&&x.textContent==='프로젝트 백업 만들기');assert.ok(save);await save.fire('click');
  await c.refresh();root=renderProduction(c);
  assert.equal(c.snapshot.backups.length,1);
  const restore=tree(root).find(x=>x.tag==='button'&&x.textContent==='새 폴더로 복원');assert.ok(restore);await restore.fire('click');
  await c.refresh();assert.equal(c.snapshot.restores.length,1);await access(join(f.directory,c.snapshot.restores[0].directory,'studio.sqlite'));
  assert.equal((await f.service.snapshot('p1')).project.title,'작품');
});

test('rendered first decoded image can declare its destination, adopt and assign the intended shot without import', async t => {
  const { png, basePixels } = await import('./helpers/images.js');
  const http = await googleHttp(t, async () => interaction([{ type: 'image', mime_type: 'image/png', data: (await png(basePixels)).toString('base64') }], { model: 'gemini-3-pro-image-preview' }));
  const f = await withAudioScene(t);
  f.service.providers.google = googleProvider({ key: 'component-test-only', baseURL: http.baseURL });
  const c = await context(t, f);
  c.selection.production = 'main';
  assert.equal(c.snapshot.slots.length, 0);
  let root = renderAssetLab(c);
  const generate = submitForm(root, '예약하고 후보 요청');
  named(generate, 'prompt').value = 'An empty room';
  named(generate, 'estimate').value = '0.01';
  await generate.fire('submit');
  assert.equal(tree(generate).find(x => x.role === 'alert').textContent, '');
  await runWorker({ service: f.service, drain: true });
  await c.refresh();
  assert.equal(http.calls.length, 1);
  assert.equal(c.snapshot.slots.length, 0);
  assert.equal(c.snapshot.candidates[0].validation.status, 'passed');
  assert.equal(c.snapshot.candidates[0].mediaKind, 'image');
  root = renderAssetLab(c);
  const adopt = submitForm(root, '후보 채택');
  assert.equal(named(adopt, 'scope').value, 'shot');
  assert.equal(named(adopt, 'subject').value, 'environment:room');
  assert.equal(named(adopt, 'state').value, '');
  // An explicit but incompatible destination is rejected by the engine and
  // does not leave an empty slot behind.
  named(adopt, 'state').value = 'adult';
  await adopt.fire('submit');
  assert.match(tree(adopt).find(x => x.role === 'alert').textContent, /SLOT_CONFLICT/);
  assert.equal((await f.service.snapshot('p1')).slots.length, 0);
  named(adopt, 'state').value = '';
  named(adopt, 'reason').value = 'Reviewed decoded first image and shot destination';
  await adopt.fire('input');
  root = renderAssetLab(c);
  await submitForm(root, '후보 채택').fire('submit');
  assert.equal(c.snapshot.slots.length, 1);
  const slot = c.snapshot.slots[0];
  assert.deepEqual(slot.scope, { kind: 'shot', id: 'shot' });
  assert.equal(slot.candidateId, c.snapshot.candidates[0].id);
  assert.equal(c.sent.some(e => e.type === 'asset.import'), false);
  root = renderAssetLab(c);
  const use = tree(root).find(x => x.tag === 'button' && x.textContent === '선택 샷에 사용');
  assert.ok(use, 'Accepted image offers explicit shot assignment');
  await use.fire('click');
  assert.equal(c.snapshot.scenes[0].shots[0].referenceSlotId, slot.id);
  assert.equal(c.snapshot.scenes[0].shots[1].referenceSlotId, undefined);
  assert.equal(c.sent.at(-1).type, 'scene.put');
});

async function castEditor(t, f) {
  const { renderCast } = await import('../ui/cast.js');
  const c = await context(t, f);
  c.selection.role = 'actor';
  const choose = async state => {
    const root = renderCast(c);
    const select = tree(root).find(x => x.tag === 'label' && x.children[0]?.textContent === '편집할 목소리 상태')?.children.find(x => x.tag === 'select');
    assert.ok(select, 'Casting state is an explicit selection, separate from the decision being saved');
    select.value = state;
    await select.fire('change');
    return renderCast(c);
  };
  const save = async (state, voice) => {
    const root = await choose(state), form = submitForm(root, '목소리 배정 저장');
    named(form, 'voice').value = voice;
    await form.fire('submit');
    assert.equal(tree(form).find(x => x.role === 'alert').textContent, '');
    return c.sent.at(-1);
  };
  return { c, choose, save, renderCast };
}
const castRows = c => c.snapshot.aggregates.filter(a => a.kind === 'casting').map(a => a.value);

test('Cast loads and edits the selected production voice without creating a competing project default', async t => {
  const f = await withAudioScene(t);
  await f.command('casting.set', { id: 'main-actor', scope: 'production', productionId: 'main', roleId: 'actor', language: 'ko', state: null, voice: 'Kore' }, { aggregate: { kind: 'casting', id: 'main-actor' } });
  const { c, renderCast } = await castEditor(t, f);
  c.selection.production = 'main';
  c.selection.scene = '';
  c.selection.occurrence = '';
  let root = renderCast(c), edit = submitForm(root, '목소리 배정 저장');
  assert.equal(named(edit, 'voice').value, 'Kore', 'the imported production voice must be visible');
  named(edit, 'voice').value = 'Leda';
  await edit.fire('submit');
  assert.equal(tree(edit).find(x => x.role === 'alert').textContent, '');
  const row = castRows(c).find(x => x.id === 'main-actor');
  assert.equal(row.voice, 'Leda');
  assert.equal(row.scope, 'production');
  assert.equal(castRows(c).filter(x => x.roleId === 'actor' && x.state == null).length, 1);
});

test('Edit blocks a frozen preview with missing audio and points to the missing takes', async t => {
  const f = await withAudioScene(t), c = await context(t, f);
  c.selection.production = 'main';
  const root = renderEdit(c);
  const create = tree(root).find(x => x.tag === 'button' && x.textContent === '새 미리보기 고정');
  assert.equal(create.disabled, true, 'incomplete media must not appear ready to render');
  assert.match(root.textContent, /음원.*3.*발화/);
  assert.equal(c.sent.length, 0);
});

test('Edit shows the adopted shot composition before audio and updates camera draft without saving', async t => {
  const { videoFixture } = await import('./helpers/render-fixture.js');
  const f = await videoFixture(t), c = await context(t, f);
  c.snapshot.slots = c.snapshot.slots.filter(x => x.mediaKind === 'image');
  const root = renderEdit(c);
  const canvas = tree(root).find(x => x.tag === 'canvas' && x['aria-label'] === '선택 샷 구도');
  assert.ok(canvas, 'the current shot image must be inspectable without frozen audio');
  const edit = submitForm(root, '샷 연출 저장');
  named(edit, 'scale').value = '1.7';
  await edit.fire('input');
  assert.equal(JSON.parse(canvas.dataset.camera).scale, 1.7);
  assert.equal(c.snapshot.scenes[0].shots[0].transform?.scale, undefined);
  assert.equal(c.sent.length, 0);
});

test('Asset Lab explains a zero application budget before enabling a Google request', async t => {
  const f = await withAudioScene(t);
  f.service.providers.google = googleProvider({ key: 'component-test-only' });
  await f.command('project.budget.set', { budgetMicros: 0 });
  const c = await context(t, f);
  c.selection.assetKind = 'audio';
  const root = renderAssetLab(c);
  const generate = tree(root).find(x => x.tag === 'button' && x.textContent === '예약하고 후보 요청');
  assert.equal(generate.disabled, true);
  assert.match(root.textContent, /Production.*예산/);
  assert.equal(c.snapshot.jobs.length, 0);
});

test('Edit does not offer a reference image owned by another production', async t => {
  const { videoFixture } = await import('./helpers/render-fixture.js');
  const f = await videoFixture(t);
  const { png, basePixels } = await import('./helpers/images.js');
  await f.command('production.create', { id: 'other', title: 'Other', sourcePackageId: null });
  await f.command('asset.import', { id: 'other-image', slot: { id: 'other-picture', scope: { kind: 'production', id: 'other' }, subject: { kind: 'environment', id: 'room' }, appearanceStateRef: null }, mediaKind: 'image', bytes: [...await png(basePixels)], actor: 'test' }, { aggregate: { kind: 'assetSlot', id: 'other-picture' } });
  const c = await context(t, f);
  const root = renderEdit(c), choices = named(submitForm(root, '샷 연출 저장'), 'referenceSlotId').children.map(x => x.value);
  assert.ok(choices.includes('picture'));
  assert.equal(choices.includes('other-picture'), false);
});

test('preview readiness honors a saved timeline that selects a take and excludes an unfinished scene', async t => {
  const { audioFixture, tone } = await import('./helpers/render-fixture.js');
  const { audioTakeSlot } = await import('./helpers/project.js');
  const { assetImport } = await import('./helpers/images.js');
  const f = await audioFixture(t);
  await assetImport(f, 'alternate-audio', tone(), audioTakeSlot('alternate-take', 'u1', 'actor', 'childvoice'), 'audio');
  await f.command('candidate.adopt', { slotId: 'alternate-take', candidateId: 'alternate-audio', actor: 'creator', reason: 'alternate' }, { aggregate: { kind: 'assetSlot', id: 'alternate-take' } });
  const source = (await f.service.snapshot('p1')).scenes[0];
  const occurrence = { ...source.occurrences[0], id: 'unfinished-speaker', sceneId: 'unfinished' };
  await f.command('scene.put', { id: 'unfinished', productionId: 'main', occurrences: [occurrence], presentations: [{ ...source.presentations[0], occurrenceId: occurrence.id }], utterances: [{ ...source.utterances[0], id: 'unfinished-u', speakerOccurrenceId: occurrence.id }], shots: [] }, { aggregate: { kind: 'scene', id: 'unfinished' } });
  await f.command('timeline.update', { productionId: 'main', sceneIds: ['scene'], utterances: [{ utteranceId: 'u1', slotId: 'take-u1' }] }, { aggregate: { kind: 'timeline', id: 'main' } });
  const c = await context(t, f);
  c.selection.production = 'main';
  c.selection.previewProfile = 'audio';
  const root = renderEdit(c), create = tree(root).find(x => x.tag === 'button' && x.textContent === '새 미리보기 고정');
  assert.equal(create.disabled, false);
  await create.fire('click');
  assert.equal(c.snapshot.editions.length, 1);
  assert.equal(c.snapshot.editions[0].closure.timeline.takes.length, 3);
});

test('a scene with no speech cannot appear ready for an audio edition', async t => {
  const { withGeneration } = await import('./helpers/project.js');
  const f = await withGeneration(t), c = await context(t, f);
  c.selection.production = 'main';
  c.selection.previewProfile = 'audio';
  const root = renderEdit(c);
  assert.equal(tree(root).find(x => x.tag === 'button' && x.textContent === '새 미리보기 고정').disabled, true);
});

test('Asset Lab explains a stale image before adoption and hides shot assignment after undo', async t => {
  const { videoFixture } = await import('./helpers/render-fixture.js');
  const { assetImport, environmentSlot, png, basePixels } = await import('./helpers/images.js');
  const f = await videoFixture(t);
  await assetImport(f, 'scene-picture', await png(basePixels), environmentSlot('scene-slot', { kind: 'scene', id: 'scene' }));
  await f.command('candidate.adopt', { slotId: 'scene-slot', candidateId: 'scene-picture', actor: 'creator', reason: 'review' }, { aggregate: { kind: 'assetSlot', id: 'scene-slot' } });
  const snapshot = await f.service.snapshot('p1');
  await f.command('scene.put', { ...snapshot.scenes[0], title: 'Changed scene' }, { aggregate: { kind: 'scene', id: 'scene' } });
  await f.command('adoption.undo', { slotId: 'scene-slot', adoptionId: snapshot.slots.find(x => x.id === 'scene-slot').adoptionId, actor: 'creator', reason: 'review' }, { aggregate: { kind: 'assetSlot', id: 'scene-slot' } });
  const c = await context(t, f);
  c.selection.slot = 'scene-slot';
  c.selection.assetKind = 'image';
  const root = renderAssetLab(c), adopt = tree(root).find(x => x.tag === 'button' && x.textContent === '후보 채택');
  assert.equal(adopt.disabled, true);
  assert.match(root.textContent, /현재 기준으로 다시 가져오거나 생성/);
  assert.equal(tree(root).some(x => x.tag === 'button' && x.textContent === '선택 샷에 사용'), false);
});

test('rendered Cast preserves default, child and adult decisions and edits the existing selected state after reload', async t => {
  const f = await withAudioScene(t), { c, save, choose, renderCast } = await castEditor(t, f);
  await save('', 'Default');
  await save('childvoice', 'Child');
  assert.equal(c.sent.at(-1).payload.id, 'childcast');
  const child = castRows(c).find(x => x.id === 'childcast');
  assert.equal(child.voice, 'Child');
  await save('adult', 'Adult');
  assert.deepEqual(castRows(c).filter(x => x.roleId === 'actor').map(x => [x.state, x.voice]).sort(), [[null, 'Default'], ['childvoice', 'Child'], ['adult', 'Adult']].sort());
  await save('adult', 'Adult updated');
  await c.refresh();
  // A fresh component context, without prior drafts or selected decision IDs.
  const reloaded = await context(t, f);
  reloaded.selection = { ...c.selection };
  const reloadForm = submitForm(renderCast(reloaded), '목소리 배정 저장');
  assert.equal(named(reloadForm, 'voice').value, 'Adult updated');
  await choose('childvoice');
  assert.equal(named(submitForm(renderCast(c), '목소리 배정 저장'), 'voice').value, 'Child');
  assert.equal(c.snapshot.resolvedBindings.find(b => b.occurrenceId === 'speaker').casting.status, 'resolved');
  assert.equal(castRows(c).filter(x => x.roleId === 'actor').length, 3);
});

test('rendered Cast occurrence-state switches preserve project and other occurrence-state assignments', async t => {
  const f = await withAudioScene(t), { c, save } = await castEditor(t, f);
  await save('', 'Project default');
  const before = castRows(c);
  c.selection.occurrence = 'speaker';
  await save('childvoice', 'Occurrence child');
  const childId = c.sent.at(-1).payload.id;
  await save('adult', 'Occurrence adult');
  const adultId = c.sent.at(-1).payload.id;
  assert.notEqual(adultId, childId);
  await save('childvoice', 'Occurrence child edited');
  assert.equal(c.sent.at(-1).payload.id, childId);
  assert.equal(castRows(c).find(x => x.id === adultId).voice, 'Occurrence adult');
  for (const row of before) assert.deepEqual(castRows(c).find(x => x.id === row.id), row);
  assert.equal(c.snapshot.resolvedBindings.find(b => b.occurrenceId === 'speaker').casting.voice, 'Occurrence child edited');
});

test('rendered Cast keeps state-specific unsaved drafts and captured CAS across switches and snapshot refresh', async t => {
  const f = await withAudioScene(t), { c, choose, renderCast, save } = await castEditor(t, f);
  await save('', 'Default');
  let root = await choose('childvoice'), form = submitForm(root, '목소리 배정 저장');
  named(form, 'voice').value = 'Unsaved child';
  await form.fire('input');
  await save('adult', 'Adult');
  await f.command('casting.set', { id: 'childcast', scope: 'project', roleId: 'actor', state: 'childvoice', voice: 'Concurrent child' }, { aggregate: { kind: 'casting', id: 'childcast' } });
  await c.refresh();
  root = await choose('childvoice');
  form = submitForm(root, '목소리 배정 저장');
  assert.equal(named(form, 'voice').value, 'Unsaved child');
  await form.fire('submit');
  assert.match(tree(form).find(x => x.role === 'alert').textContent, /다른 변경/);
  assert.equal(c.sent.at(-1).expectedRevision, 1);
  assert.equal(c.sent.at(-1).aggregate.id, 'childcast');
  assert.equal(named(submitForm(renderCast(c), '목소리 배정 저장'), 'voice').value, 'Unsaved child');
  assert.equal(castRows(c).find(x => x.id === 'childcast').voice, 'Concurrent child');
  assert.equal(castRows(c).find(x => x.state === null && x.roleId === 'actor').voice, 'Default');
});

test('rendered Cast retains a new-state draft if another client creates that state before save', async t => {
  const f = await withAudioScene(t), { c, choose, renderCast } = await castEditor(t, f);
  let root = await choose('adult'), form = submitForm(root, '목소리 배정 저장');
  named(form, 'voice').value = 'My unsaved adult';
  await form.fire('input');
  await f.command('casting.set', { id: 'other-adult', scope: 'project', roleId: 'actor', language: 'ko', state: 'adult', voice: 'Other adult' }, { aggregate: { kind: 'casting', id: 'other-adult' } });
  await c.refresh();
  root = renderCast(c);
  form = submitForm(root, '목소리 배정 저장');
  assert.equal(named(form, 'voice').value, 'My unsaved adult');
  await form.fire('submit');
  assert.match(tree(form).find(x => x.role === 'alert').textContent, /다른 변경/);
  assert.equal(castRows(c).filter(x => x.roleId === 'actor' && x.state === 'adult').length, 1);
  assert.equal(castRows(c).find(x => x.id === 'other-adult').voice, 'Other adult');
});

test('Production budget form saves through project CAS and retains a conflicting draft', async t => {
  const { renderProduction } = await import('../ui/production.js');
  const f = await withAudioScene(t), c = await context(t, f);
  let root = renderProduction(c), form = submitForm(root, '예산 한도 저장');
  named(form, 'budget').value = '2.50';
  await form.fire('submit');
  assert.equal(c.sent.at(-1).type, 'project.budget.set');
  assert.equal(c.snapshot.project.budgetMicros, 2500000);
  root = renderProduction(c); form = submitForm(root, '예산 한도 저장');
  named(form, 'budget').value = '3.00';
  await form.fire('input');
  await f.command('project.budget.set', { budgetMicros: 4000000 });
  await c.refresh();
  root = renderProduction(c); form = submitForm(root, '예산 한도 저장');
  assert.equal(named(form, 'budget').value, '3.00');
  await form.fire('submit');
  assert.match(tree(form).find(x => x.role === 'alert').textContent, /다른 변경/);
  assert.equal((await f.service.snapshot('p1')).project.budgetMicros, 4000000);
});

test('camera suggestion creates editable motion without exposing JSON and saves through the scene authority', async t => {
  const f = await withAudioScene(t), c = await context(t, f);
  const root = renderEdit(c);
  assert.equal(named(root, 'keyframes')?.tag === 'textarea', false, 'Creators should not author raw keyframe JSON');
  const preset = tree(root).find(x => x.tag === 'button' && x.textContent === '완만하게 줌인');
  assert.ok(preset, 'An actionable camera suggestion is visible');
  await preset.fire('click');
  assert.equal((await f.service.snapshot('p1')).scenes[0].shots[0].transform?.keyframes?.length ?? 0, 0, 'Suggestion remains an unsaved draft');
  await submitForm(root, '샷 연출 저장').fire('submit');
  const saved = c.snapshot.scenes[0].shots[0].transform.keyframes;
  assert.equal(saved.length, 2);
  assert.equal(saved[0].timeMs, 0);
  assert.ok(saved[1].scale > saved[0].scale);
  assert.equal(c.sent.at(-1).type, 'scene.put');
});

test('performance suggestions preserve original dialogue and structured acting on unrelated saves', async t => {
  const f = await withAudioScene(t);
  await f.command('utterance.update', { id: 'u1', acting: { emotion: '걱정', direction: '차분하게' } }, { aggregate: { kind: 'utterance', id: 'u1' } });
  const c = await context(t, f), root = renderEdit(c);
  assert.ok(!named(root, 'acting').value.includes('{'), 'No serialized acting object appears in a creator text field');
  await submitForm(root, '이 발화 저장').fire('submit');
  assert.deepEqual(c.snapshot.scenes[0].utterances[0].acting, { emotion: '걱정', direction: '차분하게' });
  const next = renderEdit(c), original = c.snapshot.scenes[0].utterances[0].text;
  const suggestion = tree(next).find(x => x.tag === 'button' && x.textContent === '따뜻한 걱정');
  assert.ok(suggestion);
  await suggestion.fire('click');
  await submitForm(next, '이 발화 저장').fire('submit');
  assert.equal(c.snapshot.scenes[0].utterances[0].text, original);
  assert.match(c.snapshot.scenes[0].utterances[0].acting, /걱정/);
});

test('production guide exposes the actual blocker and routes to the missing utterance without charging or claiming an output', async t => {
  const { renderProduction } = await import('../ui/production.js');
  const f = await withAudioScene(t), c = await context(t, f);
  c.selection.production = 'main';
  const root = renderProduction(c);
  assert.match(root.textContent, /완성 파일 없음/);
  const action = tree(root).find(x => x.tag === 'button' && x.textContent === '첫 누락 음성 준비');
  assert.ok(action, 'Next step names and opens the missing audio');
  await action.fire('click');
  assert.equal(c.selection.workspace, 'assets');
  assert.equal(c.selection.utterance, 'u1');
  assert.equal(c.selection.assetKind, 'audio');
  assert.equal(c.sent.length, 0);
  assert.equal((await f.service.snapshot('p1')).jobs.length, 0);
});

test('camera zoom-out suggestion respects an existing magnified frame', async t => {
  const f = await withAudioScene(t);
  const scene = (await f.service.snapshot('p1')).scenes[0];
  scene.shots[0].transform = { x:0, y:0, scale:2, safeArea:{left:0,top:0,right:0,bottom:0},anchor:'center',easing:'linear',keyframes:[{timeMs:333,x:0.125,y:0,scale:1.234}] };
  await f.command('scene.put',scene,{aggregate:{kind:'scene',id:'scene'}});
  const c = await context(t,f), root = renderEdit(c);
  const fractional = tree(root).filter(x=>x.tag==='input' && x['aria-label']?.includes('시점'));
  assert.ok(fractional.every(x=>x.step==='any'),'Existing valid camera precision is accepted');
  await tree(root).find(x=>x.tag==='button' && x.textContent==='천천히 줌아웃').fire('click');
  await submitForm(root,'샷 연출 저장').fire('submit');
  const frames = c.snapshot.scenes[0].shots[0].transform.keyframes;
  assert.ok(frames[0].scale > frames[1].scale,'A zoom-out must shrink even when the saved base frame is magnified');
  assert.equal(frames[1].scale,2);
});

test('legacy incomplete camera drafts remain recoverable and legacy acting drafts preserve structured performance', async t => {
  const f = await withAudioScene(t);
  const acting = { emotion: '걱정', direction: '차분하게' };
  await f.command('utterance.update', { id:'u1', acting }, {aggregate:{kind:'utterance',id:'u1'}});
  const c = await context(t,f);
  c.drafts.set('shot:scene:shot', { keyframes:'[' }, 1);
  c.drafts.set('utterance:u1', { acting:JSON.stringify(acting) }, 1);
  const root = renderEdit(c);
  assert.match(root.textContent,/이전 카메라 초안/);
  assert.equal(named(root,'keyframes').value,'[');
  assert.equal(named(root,'acting').value.includes('{'),false);
  await submitForm(root,'이 발화 저장').fire('submit');
  assert.deepEqual(c.snapshot.scenes[0].utterances[0].acting,acting);
  await tree(root).find(x=>x.tag==='button'&&x.textContent==='완만하게 줌인').fire('click');
  assert.equal(JSON.parse(named(root,'keyframes').value).length,2);
});

test('voice blocker uses only a latest unresolved Google audio request for a missing utterance', async t => {
  const { productionProgress } = await import('../ui/workflow.js');
  const f = await withAudioScene(t), s = await f.service.snapshot('p1');
  const request={productionId:'main',provider:'google',kind:'audio',target:{kind:'utterance',id:'u1'}};
  const failed={id:'failed',request,status:'outcome_unknown',providerFailure:{httpStatus:402}};
  s.attempts=[{...failed,request:{...request,kind:'image'}}];
  assert.equal(productionProgress(s,'main').rejection,undefined);
  s.attempts=[failed];
  assert.equal(productionProgress(s,'main').rejection.id,'failed');
  s.attempts.push({...failed,id:'new',status:'succeeded'});
  assert.equal(productionProgress(s,'main').rejection,undefined);
});

test('legacy structured acting edits survive an unrelated input and reopening the utterance', async t => {
  const f = await withAudioScene(t);
  await f.command('utterance.update',{id:'u1',acting:{emotion:'평온'}},{aggregate:{kind:'utterance',id:'u1'}});
  const c=await context(t,f), draftActing={emotion:'걱정',direction:'차분하게'};
  c.drafts.set('utterance:u1',{acting:JSON.stringify(draftActing)},1);
  let root=renderEdit(c), edit=submitForm(root,'이 발화 저장');
  named(edit,'holdMs').value='123';
  await edit.fire('input');
  root=renderEdit(c);
  await submitForm(root,'이 발화 저장').fire('submit');
  assert.deepEqual(c.snapshot.scenes[0].utterances[0].acting,draftActing);
  assert.equal(c.snapshot.scenes[0].utterances[0].holdMs,123);
});

test('director workspace provides a contextual inspector and an ordered dialogue timeline', async t => {
  const f=await withAudioScene(t), c=await context(t,f);
  c.selection.production='main';
  const root=renderEdit(c);
  assert.match(root.className,/director-view/);
  assert.ok(tree(root).some(x=>x['aria-label']==='샷 편집 도구'));
  assert.ok(tree(root).some(x=>x['aria-label']==='장면 발화 순서'));
});

test('screenplay selects the exact repeated-speaker cue and preserves its performance draft across director navigation', async t => {
  const {renderScript}=await import('../ui/edit.js');
  assert.equal(typeof renderScript,'function','A screenplay workspace is implemented');
  const f=await withAudioScene(t), scene=(await f.service.snapshot('p1')).scenes[0];
  scene.occurrences.find(o=>o.id==='speaker').presence='onscreen';
  scene.utterances.splice(2,0,{...scene.utterances[0],id:'u3'});
  scene.shots=scene.utterances.map((u,i)=>({id:`linked-shot-${i}`,targetOccurrenceId:u.speakerOccurrenceId==='speaker'?'speaker':null}));
  await f.command('scene.put',scene,{aggregate:{kind:'scene',id:'scene'}});
  const c=await context(t,f); c.selection.production='main';
  let root=renderScript(c);
  await tree(root).find(x=>x.tag==='button'&&x['aria-label']==='발화 3 편집').fire('click');
  assert.equal(c.selection.utterance,'u3');
  assert.equal(c.selection.shot,'linked-shot-2');
  root=renderScript(c);
  const edit=submitForm(root,'이 발화 저장');
  named(edit,'acting').value='내 초안 연기'; await edit.fire('input');
  const director=renderEdit(c);
  assert.equal(named(submitForm(director,'이 발화 저장'),'acting').value,'내 초안 연기');
  await submitForm(director,'이 발화 저장').fire('submit');
  assert.equal(c.snapshot.scenes[0].utterances[2].acting,'내 초안 연기');
});

test('management separates connected references from missing voice and links to the actual pending cue', async t => {
  const {renderProduction}=await import('../ui/production.js');
  const f=await withAudioScene(t),c=await context(t,f);c.selection.production='main';
  const root=renderProduction(c);
  assert.ok(tree(root).some(x=>x.className==='management-board'),'Readiness is an actual management view');
  assert.match(root.textContent,/연결된 자료/);
  assert.match(root.textContent,/준비할 작업/);
  assert.match(root.textContent,/검수와 완성 파일/);
  const action=tree(root).find(x=>x.tag==='button'&&x.textContent==='누락 음성 준비');
  await action.fire('click');
  assert.equal(c.selection.utterance,'u1');assert.equal(c.selection.assetKind,'audio');
  assert.equal(c.sent.length,0);
});

test('shot selection keeps the later repeated-speaker cue instead of jumping to the first', async t => {
  const {selectShot}=await import('../ui/edit.js');
  const f=await withAudioScene(t),c=await context(t,f);
  const scene=c.snapshot.scenes[0];
  scene.shots=scene.utterances.map((u,i)=>({id:`paired-${i}`,targetOccurrenceId:u.speakerOccurrenceId}));
  c.selection.utterance='u1';
  selectShot(c,scene,'paired-1');
  assert.equal(c.selection.utterance,'u2');
  assert.equal(c.selection.shot,'paired-1');
  assert.equal(c.sent.length,0);
});

test('director image inspector retains a new slot choice when the shared view rerenders', async t => {
  const {videoFixture}=await import('./helpers/render-fixture.js');
  const f=await videoFixture(t),c=await context(t,f);
  c.selection.production='main';c.selection.inspector='image';
  let root=renderEdit(c);
  const field=tree(root).find(x=>x.tag==='label'&&x.children[0]?.textContent==='자료 슬롯');
  assert.ok(field);
  const select=field.children.find(x=>x.tag==='select');
  select.value='';await select.fire('change');
  root=renderEdit(c);
  const reopened=tree(root).find(x=>x.tag==='label'&&x.children[0]?.textContent==='자료 슬롯').children.find(x=>x.tag==='select');
  assert.equal(reopened.value,'','New-slot selection must survive render');
});

test('an untargeted narrator shot selects its corresponding narration cue', async t => {
  const {selectShot}=await import('../ui/edit.js');
  const f=await withAudioScene(t),c=await context(t,f),scene=c.snapshot.scenes[0];
  scene.shots=scene.utterances.map((u,i)=>({id:`paired-${i}`,targetOccurrenceId:u.speakerOccurrenceId==='narration'?null:u.speakerOccurrenceId}));
  c.selection.utterance='u1';selectShot(c,scene,'paired-2');
  assert.equal(c.selection.utterance,'uN');
});

test('management reports actual missing image references even for an audio-only output profile', async t => {
  const {renderProduction}=await import('../ui/production.js');
  const f=await withAudioScene(t),c=await context(t,f);
  c.selection.production='main';c.selection.previewProfile='audio';
  const count=c.snapshot.scenes[0].shots.length;
  const root=renderProduction(c);
  assert.ok(root.textContent.includes(`0/${count}개 샷 연결`));
});

test('a pending image adoption cannot restore old navigation when it completes', async t => {
  const {videoFixture}=await import('./helpers/render-fixture.js');
  const f=await videoFixture(t);
  const snapshot=await f.service.snapshot('p1'),slot=snapshot.slots.find(x=>x.id==='picture');
  await f.command('adoption.undo',{slotId:slot.id,adoptionId:slot.adoptionId,actor:'test',reason:'prepare adoption'},{aggregate:{kind:'assetSlot',id:slot.id}});
  const c=await context(t,f);Object.assign(c.selection,{workspace:'edit',production:'main',inspector:'image'});
  const root=renderEdit(c),adopt=tree(root).find(x=>x.tag==='button'&&x.textContent==='후보 채택');
  assert.ok(adopt);assert.equal(adopt.disabled,false);
  let release,started;const wait=new Promise(r=>{release=r}),sending=new Promise(r=>{started=r});
  const send=c.send.bind(c);c.send=async envelope=>{started();await wait;return send(envelope);};
  const pending=submitForm(root,'후보 채택').fire('submit');await sending;
  c.selection.workspace='script';c.selection.utterance='u2';
  release();await pending;
  assert.equal(c.selection.workspace,'script');assert.equal(c.selection.utterance,'u2');
  assert.ok((await f.service.snapshot('p1')).slots.find(x=>x.id==='picture').candidateId,'The requested adoption still finishes');
});

test('management handles scenes without shots without a negative connection count', async t => {
  const {renderProduction}=await import('../ui/production.js');
  const f=await withAudioScene(t),c=await context(t,f);
  c.selection.production='main';c.snapshot.scenes[0].shots=[];
  const root=renderProduction(c);
  assert.equal(root.textContent.includes('-1/0'),false);
  assert.match(root.textContent,/샷이 없습니다/);
});


test("working shot resolves saved multilayer pose assets before evaluating its live camera preview", async (t) => {
  const { layeredFixture } = await import("./helpers/character-layers.js");
  const { renderWorkingShot } = await import("../ui/player.js");
  const f = await layeredFixture(t),
    c = await context(t, f);
  const { root, update } = renderWorkingShot(c, f.scene, f.scene.shots[0]);
  const canvas = tree(root).find((x) => x.tag === "canvas");
  assert.equal(JSON.parse(canvas.dataset.camera).x, 0);
  assert.match(root.textContent, /현재 입력 구도/);
  update({ x: 0.2 });
  assert.equal(JSON.parse(canvas.dataset.camera).x, 0.2);
});

test('native silent duration and independent music controls save through timeline commands',async t=>{
  const { renderTimingEditor }=await import('../ui/performance.js');
  const { layeredFixture }=await import('./helpers/character-layers.js');
  const { assetImport }=await import('./helpers/images.js');
  const f=await layeredFixture(t);
  const slot={id:'music',scope:{kind:'scene',id:f.scene.id},subject:{kind:'environment',id:'room'},appearanceStateRef:null,audioRole:'music'};
  await assetImport(f,'music',wav(),slot,'audio');
  await f.command('candidate.adopt',{slotId:'music',candidateId:'music',actor:'artist',reason:'explicit music'},{aggregate:{kind:'assetSlot',id:'music'}});
  const c=await context(t,f);c.selection.scene=f.scene.id;c.selection.production='main';
  const root=renderTimingEditor(c);
  named(root,'durationMs').value='700';
  await submitForm(root,'장면 길이 저장').fire('submit');
  const root2=renderTimingEditor(c);
  named(root2,'slotId').value='music';named(root2,'kind').value='music';named(root2,'startMs').value='50';
  await submitForm(root2,'독립 음원 추가').fire('submit');
  const intent=(await f.service.snapshot('p1')).timelines.find(x=>x.productionId==='main').intent;
  assert.equal(intent.sceneDurations[0].durationMs,700);
  assert.equal(intent.tracks[0].startMs,50);
  assert.equal(intent.tracks[0].slotId,'music');
});
test('native two-character layer and pose editor saves complete stack with radians and offsets',async t=>{
  const { renderLayerEditor }=await import('../ui/performance.js');
  const { layeredFixture }=await import('./helpers/character-layers.js');
  const f=await layeredFixture(t),c=await context(t,f);c.selection.scene=f.scene.id;
  const root=renderLayerEditor(c,f.scene,f.scene.shots[0]);
  named(root,'layer-1-x').value='-0.15';named(root,'layer-1-rotation').value='0.25';
  named(root,'layer-2-x').value='0.3';named(root,'layer-1-cue-0-frame').value='8';
  await submitForm(root,'레이어·포즈 저장').fire('submit');
  const shot=(await f.service.snapshot('p1')).scenes.find(x=>x.id===f.scene.id).shots[0];
  assert.equal(shot.layers.length,3);assert.equal(shot.layers[1].transform.x,-0.15);assert.equal(shot.layers[1].transform.rotation,0.25);
  assert.equal(shot.layers[2].transform.x,0.3);assert.equal(shot.layers[1].poseCues[0].frame,8);
  assert.equal(shot.layers[1].keyframes[0].frame,10);
});

test('native WAV import chooses music without a selected utterance or casting, then explicitly adopts',async t=>{
  const {withGeneration}=await import('./helpers/project.js');const f=await withGeneration(t),c=await context(t,f);
  c.selection={scene:'scene',production:'main',shot:'shot',assetKind:'audio'};
  const root=renderAssetLab(c),file=named(root,'file');
  const data=wav();file.files=[{name:'music.wav',arrayBuffer:async()=>data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength)}];
  assert.ok(named(root,'audioRole'),'A native sound role control is required');
  named(root,'audioRole').value='music';
  await submitForm(root,'파일 가져오기').fire('submit');
  let s=await f.service.snapshot('p1');assert.equal(s.slots[0].audioRole,'music');assert.equal(s.slots[0].utteranceId,null);assert.equal(s.adoptions.length,0);assert.equal(s.jobs.length,0);
  const adopted=renderAssetLab(c);await submitForm(adopted,'후보 채택').fire('submit');
  s=await f.service.snapshot('p1');assert.equal(s.adoptions.length,1);assert.equal(s.slots[0].candidateId,s.candidates[0].id);
});

test('Library DOM inspects actual normalized bytes, queues preserve, and leaves adoption explicit',async t=>{
  const {renderReuseSelection,PreservationQueue}=await import('../ui/library.js');
  const {bundleFixture,ref}=await import('./helpers/bundles.js');const {hashBytes}=await import('../src/source/source-package.js');
  const sharp=(await import('sharp')).default;
  const f=await withAudioScene(t),c=await context(t,f),bytes=await sharp({create:{width:2,height:2,channels:3,background:'red'}}).jpeg().toBuffer(),hash=hashBytes(bytes);
  const exported=bundleFixture({records:[{ref:ref(),metadata:{mediaKind:'image',roles:['environment-reference'],subjects:[]},requiredFileSha256s:[hash],sourcePins:{},evidenceRefs:[]}],files:[{sha256:hash,byteLength:bytes.length,mime:'image/jpeg',role:'selected-content'}]});exported.bytes={[hash]:[...bytes]};
  const queue=await new PreservationQueue('test',{load:async()=>[],save:async()=>{}}).load();
  const state={entry:{ref:ref(),title:'Actual JPEG fixture'},exported,queue};
  c.api.inspectReuse=request=>f.service.inspectReuse({projectId:'p1',...request});
  let root=renderReuseSelection(c,state);named(root,'purpose').value='Different scene setting';named(root,'slotId').value='library-scene';
  await submitForm(root,'목적·연결 검사').fire('submit');
  assert.equal(state.inspection.disposition,'compatible');assert.notEqual(state.inspection.materializations[0].sourceSha256,state.inspection.materializations[0].canonicalSha256);
  root=renderReuseSelection(c,state);await tree(root).find(x=>x.tag==='button'&&x.textContent==='검사한 자료 보존 대기열에 추가').fire('click');
  assert.equal(queue.items.length,1);await queue.resume(envelope=>f.service.command(envelope));
  const s=await f.service.snapshot('p1');assert.ok(queue.items[0].receipt.value.importReceipt);assert.equal(s.adoptions.length,0);assert.equal(s.jobs.length,0);
  const unsupported={...state,exported:structuredClone(exported)};unsupported.exported.bundle.records[0].metadata.mediaKind='video';
  assert.match(renderReuseSelection(c,unsupported).textContent,/지원하지 않습니다/);
});

test('Library panel displays exact offline observation time and missing distinction without source access',async t=>{
  const {renderLibrary,PreservationQueue}=await import('../ui/library.js');const {ref}=await import('./helpers/bundles.js');const f=await withAudioScene(t),c=await context(t,f);
  c.api.bootstrap.library={available:true};c.libraryState={loaded:true,result:{registryRevision:1,owners:[],entries:[{ref:ref(),title:'Old exact pose',mediaKind:'image',availability:'offline',capabilities:['discover','preserve'],roles:['pose'],observed:{at:'2026-10-21T01:02:03.000Z'}}]},queue:await new PreservationQueue('display',{load:async()=>[],save:async()=>{}}).load()};
  const root=renderLibrary(c);assert.match(root.textContent,/Old exact pose.*offline.*2026-10-21T01:02:03.000Z/);assert.match(root.textContent,/missing/);assert.match(root.textContent,/실시간 보장이 아닙니다/);
});

test('silent scene without any shot exposes native duration controls in Edit',async t=>{
  const {withGeneration}=await import('./helpers/project.js');const f=await withGeneration(t);
  const scene=(await f.service.snapshot('p1')).scenes[0];scene.shots=[];await f.command('scene.put',scene,{aggregate:{kind:'scene',id:'scene'}});
  const c=await context(t,f);c.selection={production:'main',scene:'scene',inspector:'layers'};
  const root=renderEdit(c);assert.ok(named(root,'durationMs'),'A silent shotless scene still needs authorable duration');
  named(root,'durationMs').value='500';await submitForm(root,'장면 길이 저장').fire('submit');assert.equal((await f.service.snapshot('p1')).timelines[0].intent.sceneDurations[0].durationMs,500);
});


async function retainedLayerImages(t) {
  const { layeredFixture } = await import('./helpers/character-layers.js');
  const { bundleFixture, ref, pngSha256 } = await import('./helpers/bundles.js');
  const f = await layeredFixture(t), slots = {};
  for (const role of ['style-reference', 'edit-target', 'identity-reference', 'pose', 'environment-reference', 'final-scene']) {
    const source = ref(), state = ref({ recordKind: 'state', recordId: 'appearance' });
    const subject = { ownerId: source.ownerId, projectId: source.projectId, identityId: 'hero', stateRefs: [state] };
    const environment = ['environment-reference', 'final-scene'].includes(role);
    const slot = { id: `retained-${role}`, scope: { kind: 'project', id: 'p1' },
      subject: environment ? { kind: 'environment', id: 'stage' } : { kind: 'identity', id: 'char' },
      appearanceStateRef: environment ? null : 'adult' };
    const data = bundleFixture({ records: [{ ref: source, metadata: { mediaKind: 'image', roles: [role], subjects: environment ? [] : [subject], selectedContentSha256: pngSha256 }, requiredFileSha256s: [pngSha256], sourcePins: {}, evidenceRefs: [] }] });
    const intent = { target: { kind: 'assetSlot', id: slot.id }, purpose: 'Review exact retained image role',
      identityMap: environment ? [] : [{ source: subject, destinationIdentityId: 'char' }],
      stateMap: environment ? [] : [{ source: state, destinationStateId: 'adult' }],
      selections: [{ source, slot, role }] };
    const inspected = await f.service.inspectReuse({ projectId: 'p1', ...data, intent });
    assert.equal(inspected.disposition, 'compatible');
    let candidate = (await f.command('asset.importBundle', { ...data, intent, inspectionDigest: inspected.inspectionDigest, actor: 'artist', reason: 'Preserve actual role' }, { aggregate: intent.target })).value.candidate;
    await f.command('candidate.adopt', { slotId: slot.id, candidateId: candidate.id, actor: 'artist', reason: 'Explicit role selection' }, { aggregate: intent.target });
    if (role === 'style-reference') {
      candidate = (await f.command('asset.derive', { id: 'derived-style', slotId: slot.id, baseCandidateId: candidate.id, operation: 'crop', rect: { left: 0, top: 0, width: 1, height: 1 }, actor: 'artist' }, { aggregate: intent.target })).value.candidate;
      assert.equal(candidate.reuseRole, role, 'A derived reference retains its consumer role');
      await f.command('candidate.adopt', { slotId: slot.id, candidateId: candidate.id, actor: 'artist', reason: 'Select derived reference' }, { aggregate: intent.target });
    }
    slots[role] = slot;
  }
  return { ...f, retainedSlots: slots };
}

test('layer editor separates retained baseline and pose roles, explains exclusions and keeps legacy choices', async t => {
  const { renderLayerEditor } = await import('../ui/performance.js');
  const f = await retainedLayerImages(t), c = await context(t, f), scene = structuredClone(f.scene);
  scene.shots[0].layers = [scene.shots[0].layers[1]];
  scene.shots[0].layers[0].slotId = f.retainedSlots['identity-reference'].id;
  scene.shots[0].layers[0].poseCues[0].slotId = f.retainedSlots.pose.id;
  const root = renderLayerEditor(c, scene, scene.shots[0]);
  const enabled = select => select.children.filter(option => !option.disabled).map(option => option.value);
  const baseline = enabled(named(root, 'layer-0-slotId'));
  const cues = enabled(named(root, 'layer-0-cue-0-slot'));
  for (const role of ['style-reference', 'edit-target']) {
    assert.equal(baseline.includes(f.retainedSlots[role].id), false, `${role} must stay reference-only`);
    assert.equal(cues.includes(f.retainedSlots[role].id), false);
  }
  for (const role of ['identity-reference', 'pose', 'environment-reference', 'final-scene'])
    assert.ok(baseline.includes(f.retainedSlots[role].id), `Supported ${role} baseline is available`);
  assert.ok(cues.includes(f.retainedSlots.pose.id));
  for (const role of ['identity-reference', 'environment-reference', 'final-scene'])
    assert.equal(cues.includes(f.retainedSlots[role].id), false, `${role} is not an explicit pose`);
  assert.ok(baseline.includes('red') && cues.includes('blue'), 'Native no-marker images retain legacy selection rules');
  assert.match(root.textContent, /style-reference.*edit-target.*참조/);
  assert.match(root.textContent, /identity-reference.*pose/);
  const invalidScene = structuredClone(scene);
  invalidScene.shots[0].layers[0].slotId = f.retainedSlots['style-reference'].id;
  invalidScene.shots[0].layers[0].poseCues[0].slotId = f.retainedSlots['identity-reference'].id;
  const invalid = renderLayerEditor(c, invalidScene, invalidScene.shots[0]);
  assert.equal(named(invalid, 'layer-0-slotId').children.find(x => x.value === f.retainedSlots['style-reference'].id).disabled, true);
  assert.equal(named(invalid, 'layer-0-cue-0-slot').children.find(x => x.value === f.retainedSlots['identity-reference'].id).disabled, true);
  assert.match(invalid.textContent, /지원하지 않는 선택.*역할·범위 확인/);
  await tree(root).find(x => x.tag === 'button' && x.textContent === '포즈 전환 추가').fire('click');
  assert.ok(enabled(named(root, 'layer-0-cue-1-slot')).includes(named(root, 'layer-0-cue-1-slot').value));
  assert.notEqual(named(root, 'layer-0-cue-1-slot').value, f.retainedSlots['identity-reference'].id, 'Adding a cue cannot copy an identity-only baseline');
  await submitForm(root, '레이어·포즈 저장').fire('submit');
  const saved = (await f.service.snapshot('p1')).scenes.find(x => x.id === scene.id).shots[0].layers[0];
  assert.equal(saved.slotId, f.retainedSlots['identity-reference'].id);
  assert.equal(saved.poseCues[0].slotId, f.retainedSlots.pose.id);
});

test('layer editor disables unavailable pose and baseline additions with visible reasons', async t => {
  const { renderLayerEditor } = await import('../ui/performance.js');
  const f = await retainedLayerImages(t), c = await context(t, f), scene = structuredClone(f.scene);
  scene.shots[0].layers = [{ ...scene.shots[0].layers[1], slotId: f.retainedSlots['identity-reference'].id, poseCues: [] }];
  c.snapshot.slots = c.snapshot.slots.filter(x => x.id === f.retainedSlots['identity-reference'].id);
  let root = renderLayerEditor(c, scene, scene.shots[0]);
  assert.equal(tree(root).find(x => x.tag === 'button' && x.textContent === '포즈 전환 추가').disabled, true);
  assert.match(root.textContent, /포즈 전환.*pose.*없/);
  c.snapshot.slots = (await f.service.snapshot('p1')).slots.filter(x => x.id === f.retainedSlots['style-reference'].id);
  scene.shots[0].layers = [];
  root = renderLayerEditor(c, scene, scene.shots[0]);
  assert.equal(tree(root).find(x => x.tag === 'button' && x.textContent === '레이어 추가').disabled, true);
  assert.match(root.textContent, /기본 레이어.*없/);
});

test('structural layer, movement and pose edits persist drafts across every rerender', async t => {
  const { renderLayerEditor } = await import('../ui/performance.js');
  const { layeredFixture } = await import('./helpers/character-layers.js');
  const f = await layeredFixture(t), c = await context(t, f), scene = structuredClone(f.scene);
  scene.shots[0].layers = [scene.shots[0].layers[1]];
  let persisted = 0, root = renderLayerEditor(c, scene, scene.shots[0]);
  c.persist = () => { persisted++; };
  const layers = () => JSON.parse(named(root, 'layers').value);
  const edit = async (label, verify) => {
    const before = persisted;
    await tree(root).filter(x => x.tag === 'button' && x.textContent === label).at(-1).fire('click');
    assert.equal(persisted, before + 1, `${label} must trigger the form's durable draft hook`);
    verify(layers());
    root = renderLayerEditor(c, scene, scene.shots[0]);
    verify(layers());
  };
  await edit('움직임 시점 추가', value => assert.equal(value[0].keyframes.length, 2));
  await edit('포즈 전환 추가', value => assert.equal(value[0].poseCues.length, 2));
  await edit('마지막 움직임 제거', value => assert.equal(value[0].keyframes.length, 1));
  await edit('마지막 포즈 제거', value => assert.equal(value[0].poseCues.length, 1));
  await edit('레이어 추가', value => assert.equal(value.length, 2));
  await edit('레이어 제거', value => assert.equal(value.length, 1));
  assert.equal(c.drafts.get(`layers:${scene.id}:${scene.shots[0].id}`).revision, c.snapshot.aggregates.find(x => x.kind === 'scene' && x.id === scene.id).revision);
  await submitForm(root, '레이어·포즈 저장').fire('submit');
  assert.equal((await f.service.snapshot('p1')).scenes.find(x => x.id === scene.id).shots[0].layers.length, 1);
});
