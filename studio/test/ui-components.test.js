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
