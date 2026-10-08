import { command, revision } from "./api.js";
import {
  el,
  card,
  note,
  form,
  button,
  select,
  options,
  uid,
  chosenScene,
  stateOptions,
  nullish,
  details,
} from "./dom.js";
export function filterCast(
  snapshot,
  query = "",
  filter = "all",
  sceneId = null,
) {
  const scene = snapshot.scenes.find((s) => s.id === sceneId);
  return snapshot.cast.filter(
    (r) =>
      `${r.name} ${r.id}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()) &&
      (filter === "all" ||
        (filter === "characterless" && !r.characterId) ||
        (filter === "scene" &&
          scene?.occurrences.some((o) => o.roleBindingId === r.id)) ||
        (filter === "unassigned" &&
          !snapshot.resolvedBindings.some(
            (b) => b.roleBindingId === r.id && b.casting.status === "resolved",
          ))),
  );
}
export function occurrenceCommand(
  snapshot,
  sceneId,
  p,
  expectedRevision = revision(snapshot, "scene", sceneId),
) {
  const scene = structuredClone(snapshot.scenes.find((s) => s.id === sceneId));
  const role = snapshot.cast.find((r) => r.id === p.roleId);
  const id = p.occurrenceId || uid("occurrence");
  const occurrence = {
    id,
    sceneId,
    roleBindingId: role.id,
    characterId: role.characterId ?? null,
    presence: p.presence,
    temporalStateRef: p.temporalStateRef || null,
    knowledgeStateRef: p.knowledgeStateRef || null,
  };
  const presentation = {
    occurrenceId: id,
    appearanceStateRef: p.appearanceStateRef || null,
    castingStateRef: p.castingStateRef || null,
    knowledgeStateRef: p.knowledgeStateRef || null,
  };
  scene.occurrences = [
    ...scene.occurrences.filter((o) => o.id !== id),
    occurrence,
  ];
  scene.presentations = [
    ...scene.presentations.filter((o) => o.occurrenceId !== id),
    presentation,
  ];
  return command(
    snapshot,
    "scene.put",
    "scene",
    sceneId,
    scene,
    expectedRevision,
  );
}
export function renderCast(c) {
  const s = c.snapshot,
    scene = chosenScene(c);
  const root = el("div", { class: "workspace-grid" });
  const roster = card(
    "배역 라이브러리",
    note(`${s.cast.length}개 배역 · 인물, 출현, 목소리는 각각 저장됩니다.`),
  );
  const list = el("div", { class: "roster" });
  let query = c.selection.castQuery ?? "",
    filter = c.selection.castFilter ?? "all";
  const paint = () => {
    const roles = filterCast(s, query, filter, scene?.id);
    list.replaceChildren(
      ...roles.map((r) =>
        button(
          r.name,
          () => {
            c.selection.role = r.id;
            c.persist();
            c.render();
          },
          {
            class:
              c.selection.role === r.id
                ? "roster-item selected"
                : "roster-item",
          },
        ),
      ),
    );
  };
  roster.append(
    el(
      "label",
      { class: "field" },
      el("span", {}, "배역 검색"),
      el("input", {
        type: "search",
        value: query,
        oninput: (e) => {
          query = e.target.value;
          c.selection.castQuery = query;
          c.persist();
          paint();
        },
      }),
    ),
    select(
      "목록 필터",
      filter,
      [
        { value: "all", label: "전체 배역" },
        { value: "scene", label: "현재 장면" },
        { value: "characterless", label: "인물 없는 배역" },
        { value: "unassigned", label: "장면 목소리 미배정" },
      ],
      (value) => {
        filter = value;
        c.selection.castFilter = filter;
        c.persist();
        paint();
      },
    ),
    list,
  );
  paint();
  root.append(roster);
  const editor = el("div");
  const role = s.cast.find((r) => r.id === c.selection.role);
  editor.append(
    card(
      "새 배역",
      form(
        c,
        "new-role",
        [
          { name: "name", label: "배역 이름", required: true },
          {
            name: "identity",
            label: "인물 연결",
            options: [
              { value: "new", label: "새 인물" },
              { value: "none", label: "인물 없는 해설·군중" },
              ...s.cast
                .filter((r) => r.identity)
                .map((r) => ({
                  value: r.characterId,
                  label: `같은 인물 · ${r.name}`,
                })),
            ],
          },
          { name: "language", label: "언어", value: s.project.language },
        ],
        async (p) => {
          const id = uid("role"),
            characterId =
              p.identity === "none"
                ? null
                : p.identity === "new"
                  ? uid("person")
                  : p.identity;
          await c.send(
            command(s, "cast.put", "cast", id, {
              id,
              name: p.name,
              language: p.language,
              characterId,
              ...(p.identity === "new"
                ? {
                    identity: {
                      id: characterId,
                      origin: { kind: "studioLocal" },
                    },
                  }
                : {}),
            }),
          );
          c.selection.role = id;
        },
        { submit: "배역 만들기" },
      ),
    ),
  );
  if (role) {
    editor.append(
      card(
        role.name,
        note(
          `선택 배역 · ${role.language} · ${role.characterId ? "인물 연결됨" : "인물 없는 배역"}`,
        ),
        details("식별 정보", role),
      ),
    );
    const occurrences =
      scene?.occurrences.filter((o) => o.roleBindingId === role.id) ?? [];
    const occurrence = occurrences.find((o) => o.id === c.selection.occurrence);
    const presentation = scene?.presentations.find(
      (p) => p.occurrenceId === occurrence?.id,
    );
    if (scene) {
      editor.append(
        card(
          "장면 출현",
          note(
            `${scene.title ?? scene.id} · 출현마다 시점, 외형, 목소리 상태를 구분합니다.`,
          ),
          select(
            "편집할 출현",
            occurrence?.id ?? "",
            [
              { value: "", label: "새 출현" },
              ...occurrences.map((o) => ({
                value: o.id,
                label: `${o.presence} · ${o.id.slice(0, 18)}`,
              })),
            ],
            (id) => {
              c.selection.occurrence = id;
              c.persist();
              c.render();
            },
          ),
          form(
            c,
            `occurrence:${scene.id}:${occurrence?.id ?? role.id}`,
            [
              {
                name: "presence",
                label: "등장 방식",
                value: occurrence?.presence ?? "onscreen",
                options: [
                  "onscreen",
                  "offscreen",
                  "voiceover",
                  "inner",
                  "narrator",
                  "ensemble",
                ].map((v, i) => ({
                  value: v,
                  label: [
                    "화면 속",
                    "화면 밖",
                    "보이스오버",
                    "속마음",
                    "해설",
                    "군중",
                  ][i],
                })),
              },
              ...[
                "temporalStateRef",
                "appearanceStateRef",
                "castingStateRef",
                "knowledgeStateRef",
              ].map((name, i) => ({
                name,
                label: [
                  "이야기 시점",
                  "보이는 외형",
                  "목소리 상태",
                  "알고 있는 정보",
                ][i],
                value: occurrence?.[name] ?? presentation?.[name] ?? "",
                options: stateOptions(c),
              })),
            ],
            async (p, rev) => {
              await c.send(
                occurrenceCommand(
                  s,
                  scene.id,
                  { ...p, roleId: role.id, occurrenceId: occurrence?.id },
                  rev,
                ),
              );
            },
            {
              submit: occurrence ? "출현 저장" : "장면에 추가",
              revision: revision(s, "scene", scene.id),
            },
          ),
        ),
      );
    }
    const scope = occurrence ? "occurrence" : "project";
    const scopeKey = JSON.stringify([
      scope,
      occurrence ? scene.productionId : null,
      occurrence ? scene.id : null,
      occurrence?.id ?? null,
      role.id,
      role.language,
    ]);
    const states = c.selection.castingStates ??= {};
    const selectedState = states[scopeKey] ?? presentation?.castingStateRef ?? "";
    const identityKey = JSON.stringify([scopeKey, selectedState]);
    const matchesIdentity = (a) =>
      a.kind === "casting" &&
      a.value.scope === scope &&
      a.value.roleId === role.id &&
      (a.value.language ?? role.language) === role.language &&
      !a.value.allStates &&
      (scope !== "occurrence" ||
        (a.value.occurrenceId === occurrence.id &&
          a.value.sceneId === scene.id &&
          a.value.productionId === scene.productionId)) &&
      (a.value.state ?? "") === selectedState;
    const existing = s.aggregates.find(matchesIdentity);
    const formKey = `casting:${identityKey}`;
    // A draft keeps its original decision and CAS, even if a refresh finds a
    // different decision for the same identity. Discarding the draft reloads it.
    const pendingIds = c.selection.castingDecisionIds ??= {};
    const decisionId =
      c.drafts.get(formKey) && pendingIds[identityKey]
        ? pendingIds[identityKey]
        : existing?.id ?? pendingIds[identityKey] ?? uid("voice");
    pendingIds[identityKey] = decisionId;
    const d = existing?.value;
    editor.append(
      card(
        "목소리 배정",
        note(
          occurrence ? "선택한 장면 출현에 적용" : "이 배역의 작품 기본 목소리",
        ),
        select(
          "편집할 목소리 상태",
          selectedState,
          stateOptions(c),
          (state) => {
            states[scopeKey] = state;
            c.persist();
            c.render();
          },
        ),
        form(
          c,
          formKey,
          [
            {
              name: "voice",
              label: "목소리 ID",
              value: d?.voice ?? "",
              required: true,
              help: "Google 기본 목소리(Kore 등), 기존 voice_ ID 또는 수동 녹음 이름. 여러 배역이 같은 목소리를 써도 인물은 합쳐지지 않습니다.",
            },
          ],
          async (p, rev) => {
            const current = c.snapshot.aggregates.find(matchesIdentity);
            if (current && current.id !== decisionId)
              throw Object.assign(
                new Error("Casting identity changed while editing."),
                { code: "REVISION_CONFLICT" },
              );
            await c.send(
              command(
                s,
                "casting.set",
                "casting",
                decisionId,
                {
                  id: decisionId,
                  scope,
                  roleId: role.id,
                  language: role.language,
                  state: nullish(selectedState),
                  voice: p.voice,
                  ...(occurrence
                    ? {
                        productionId: scene.productionId,
                        sceneId: scene.id,
                        occurrenceId: occurrence.id,
                      }
                    : {}),
                },
                rev,
              ),
            );
          },
          {
            revision: revision(s, "casting", decisionId),
            submit: "목소리 배정 저장",
          },
        ),
        details(
          "기본 목소리 목록",
          c.api.bootstrap.providers?.find((p) => p.provider === "google")
            ?.voices ?? [],
        ),
        note(
          "저장된 사용자 목소리의 만료일과 실제 발성 일치 여부는 확인되지 않았습니다.",
        ),
      ),
    );
  }
  root.append(editor);
  return root;
}
