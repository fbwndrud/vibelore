import { StudioAPI, Drafts, command } from "./api.js";
import { el, button, form, note, select } from "./dom.js";
import { renderStory } from "./story.js";
import { renderCast } from "./cast.js";
import { renderAssetLab } from "./asset-lab.js";
import { renderEdit } from "./edit.js";
import { renderProduction } from "./production.js";
const api = new StudioAPI(),
  drafts = new Drafts(),
  root = document.querySelector("#app");
const workspaces = {
  story: ["Story", "원고와 각색", renderStory],
  cast: ["Cast", "인물과 목소리", renderCast],
  assets: ["Asset Lab", "그림과 음성", renderAssetLab],
  edit: ["Edit", "장면 연출", renderEdit],
  production: ["Production", "작업과 예산", renderProduction],
};
const c = {
  api,
  drafts,
  snapshot: null,
  selection: {
    workspace: "story",
    production: "",
    scene: "",
    shot: "",
    occurrence: "",
    utterance: "",
    role: "",
    slot: "",
    candidate: "",
  },
  urls: new Set(),
  persist() {
    try {
      localStorage.setItem(
        `studio-ui:${api.projectId}`,
        JSON.stringify({ selection: c.selection, drafts: [...drafts.items] }),
      );
    } catch {}
  },
  status(text) {
    const node = document.querySelector("#status");
    if (node) node.textContent = text;
  },
  async send(envelope) {
    return api.command(envelope);
  },
  async run(fn) {
    try {
      await fn();
      c.status("저장되었습니다.");
    } catch (e) {
      c.status(`작업을 마치지 못했습니다 · ${e.code ?? e.message}`);
    }
  },
  async refresh(render = false) {
    try {
      c.snapshot = await api.snapshot();
    } catch (e) {
      if (e.code !== "PROJECT_NOT_FOUND") throw e;
      c.snapshot = null;
    }
    if (render) c.render();
    else {
      const node = document.querySelector("#live-status");
      if (node) node.textContent = "새 변경이 있습니다 · 입력 초안 유지";
    }
  },
  render,
};
function normalize() {
  if (!c.snapshot) return;
  const s = c.snapshot;
  if (!s.productions.some((p) => p.id === c.selection.production))
    c.selection.production = s.productions[0]?.id ?? "";
  if (
    c.selection.scene &&
    !s.scenes.some(
      (scene) =>
        scene.id === c.selection.scene &&
        scene.productionId === c.selection.production,
    )
  )
    c.selection.scene = "";
  const scene = s.scenes.find((s) => s.id === c.selection.scene);
  for (const [key, list] of [
    ["shot", scene?.shots],
    ["utterance", scene?.utterances],
    ["occurrence", scene?.occurrences],
  ])
    if (c.selection[key] && !list?.some((x) => x.id === c.selection[key]))
      c.selection[key] = "";
  if (c.selection.role && !s.cast.some((r) => r.id === c.selection.role))
    c.selection.role = "";
}
function render() {
  for (const dispose of c.cleanups ?? []) dispose();
  c.cleanups?.clear();
  for (const url of c.urls) URL.revokeObjectURL(url);
  c.urls.clear();
  normalize();
  root.replaceChildren();
  const shell = el("div", { class: "shell" });
  shell.append(
    el(
      "header",
      { class: "topbar" },
      el(
        "div",
        { class: "brand" },
        el("span", { class: "brand-mark", "aria-hidden": "true" }, "L"),
        el(
          "div",
          {},
          el("strong", {}, "LORE STUDIO"),
          el("span", { class: "brand-sub" }, "이야기가 장면이 되는 작업실"),
        ),
      ),
      el(
        "div",
        { class: "project-title" },
        c.snapshot?.project.title ?? "새 이야기",
      ),
      el(
        "div",
        { class: "connection" },
        el("span", { class: "live-dot", "aria-hidden": "true" }),
        "로컬 저장",
      ),
    ),
  );
  shell.append(
    el(
      "div",
      { id: "status", role: "status", "aria-live": "polite", class: "status" },
      "변경은 저장 버튼을 누를 때 기록됩니다.",
    ),
  );
  if (!c.snapshot) {
    shell.append(
      el(
        "main",
        { class: "welcome" },
        el("p", { class: "eyebrow" }, "YOUR NEXT STORY"),
        el("h1", {}, "아직 없는 장면을,\n하나씩 만들어 갑니다."),
        note("원고에서 시작해도, 그림 한 장에서 시작해도 괜찮습니다."),
        form(
          c,
          "project-create",
          [
            { name: "title", label: "작품 제목", required: true },
            {
              name: "language",
              label: "작품 언어",
              value: "ko",
              required: true,
            },
            {
              name: "budget",
              label: "생성 발급 예산 (USD)",
              type: "number",
              value: "0",
              min: 0,
              step: "0.01",
            },
          ],
          async (p) =>
            api.command(
              command(null, "project.create", "project", api.projectId, {
                title: p.title,
                language: p.language,
                budgetMicros: Math.round(Number(p.budget) * 1e6),
              }),
            ),
          { submit: "작업실 만들기" },
        ),
      ),
    );
    root.append(shell);
    return;
  }
  const nav = el("nav", { class: "tabs", "aria-label": "작업 공간" });
  for (const [key, [name, description]] of Object.entries(workspaces))
    nav.append(
      button(
        [el("strong", {}, name), el("span", {}, description)],
        () => {
          c.selection.workspace = key;
          c.persist();
          c.render();
        },
        {
          "aria-current": c.selection.workspace === key ? "page" : null,
          class: c.selection.workspace === key ? "active" : "",
        },
      ),
    );
  nav.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    const buttons = [...nav.querySelectorAll("button")],
      index = buttons.indexOf(e.target);
    if (index < 0) return;
    e.preventDefault();
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? buttons.length - 1
          : (index + (e.key === "ArrowRight" ? 1 : -1) + buttons.length) %
            buttons.length;
    buttons[next].click();
    document.querySelectorAll(".tabs button")[next].focus();
  });
  shell.append(nav);
  const body = el("div", { class: "body" }),
    rail = el("aside", { class: "scene-rail" });
  rail.append(
    select(
      "제작판",
      c.selection.production,
      [
        { value: "", label: "제작판 선택" },
        ...c.snapshot.productions.map((p) => ({ value: p.id, label: p.title })),
      ],
      (id) => {
        c.selection.production = id;
        c.selection.scene = "";
        c.persist();
        c.render();
      },
    ),
    button(
      "+ 제작판",
      () => {
        c.selection.workspace = "production";
        c.persist();
        c.render();
      },
      { class: "quiet" },
    ),
    el("p", { class: "eyebrow" }, "SCENES"),
  );
  for (const [i, scene] of c.snapshot.scenes
    .filter((s) => s.productionId === c.selection.production)
    .entries()) {
    rail.append(
      button(
        [
          el("span", { class: "scene-index" }, String(i + 1).padStart(2, "0")),
          el("strong", {}, scene.title ?? "제목 없는 장면"),
          el(
            "small",
            {},
            `${scene.utterances.length} 발화 · ${scene.shots.length} 샷`,
          ),
        ],
        () => {
          c.selection.scene = scene.id;
          c.selection.shot = scene.shots[0]?.id ?? "";
          c.selection.utterance = scene.utterances[0]?.id ?? "";
          c.selection.occurrence =
            scene.utterances[0]?.speakerOccurrenceId ??
            scene.occurrences[0]?.id ??
            "";
          c.persist();
          c.render();
        },
        {
          class: `scene-card ${c.selection.scene === scene.id ? "selected" : ""}`,
        },
      ),
    );
    if (scene.id === c.selection.scene)
      for (const shot of scene.shots)
        rail.append(
          button(
            shot.title ?? "샷",
            () => {
              c.selection.shot = shot.id;
              c.persist();
              c.render();
            },
            {
              class: `shot-link ${c.selection.shot === shot.id ? "selected" : ""}`,
            },
          ),
        );
  }
  rail.append(
    button(
      "+ 장면",
      () => {
        c.selection.scene = "";
        c.selection.workspace = "story";
        c.persist();
        c.render();
      },
      { class: "quiet" },
    ),
  );
  body.append(rail);
  const [name, description, renderWorkspace] =
    workspaces[c.selection.workspace] ?? workspaces.story;
  body.append(
    el(
      "main",
      { id: "workspace", class: "workspace" },
      el(
        "div",
        { class: "workspace-heading" },
        el(
          "div",
          {},
          el("p", { class: "eyebrow" }, name),
          el("h1", {}, description),
        ),
        button("최신 작업 불러오기", () => c.run(() => c.refresh(true)), {
          class: "quiet",
        }),
      ),
      el("p", { id: "live-status", class: "muted" }),
      renderWorkspace(c),
    ),
  );
  shell.append(
    body,
    el("footer", {}, "LOCAL WORKSPACE · 원작과 제작 자료를 구분해 보관합니다."),
  );
  root.append(shell);
  c.persist();
}
async function listen() {
  let after = c.snapshot?.eventCursor ?? 0;
  while (true) {
    if (!c.snapshot) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      continue;
    }
    try {
      await api.events(after, undefined, async (event) => {
        after = event.cursor;
        await c.refresh(false);
      });
    } catch {
      c.status("연결을 다시 확인하고 있습니다. 입력 초안은 유지됩니다.");
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}
try {
  await api.connect();
  try {
    const saved = JSON.parse(
      localStorage.getItem(`studio-ui:${api.projectId}`),
    );
    if (saved?.selection) c.selection = { ...c.selection, ...saved.selection };
    for (const [key, value] of saved?.drafts ?? [])
      drafts.items.set(key, value);
  } catch {}
  await c.refresh(true);
  listen();
} catch (e) {
  root.replaceChildren(
    el(
      "main",
      { class: "welcome" },
      el("h1", {}, "작업실 연결을 확인하세요."),
      note(e.code ?? e.message),
      button("다시 연결", () => location.reload()),
    ),
  );
}
