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
