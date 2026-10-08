import { command, revision } from "./api.js";
import {
  el,
  card,
  note,
  form,
  button,
  uid,
  chosenScene,
  selectedProduction,
  details,
} from "./dom.js";
import { generationCommand } from "./production.js";
export function proposalApplied(snapshot, candidate) {
  return snapshot.scenes.some(
    (scene) =>
      scene.adaptationDecision?.candidateId === candidate.id ||
      scene.utterances.some(
        (u) => u.adaptationDecision?.candidateId === candidate.id,
      ),
  );
}
export function sceneAdaptationRequest(
  snapshot,
  scene,
  { model, estimateMicros, direction },
) {
  const source = snapshot.sourcePackages.find(
    (p) =>
      p.id === scene.sourcePackageId ||
      (!scene.sourcePackageId &&
        p.id ===
          snapshot.productions.find((x) => x.id === scene.productionId)
            ?.sourcePackageId),
  );
  const units =
    source?.textUnits.filter((u) => scene.sourceUnitIds?.includes(u.id)) ?? [];
  if (!units.length || !scene.occurrences.length)
    throw new Error("허용 원문과 화자 출현을 먼저 지정하세요.");
  const unitSchema = {
    type: "array",
    minItems: 1,
    items: { type: "string", enum: units.map((u) => u.id) },
  };
  const schema = {
    type: "object",
    properties: {
      sceneId: { type: "string", enum: [scene.id] },
      sourceUnitIds: unitSchema,
      utterances: {
        type: "array",
        minItems: 1,
        maxItems: 200,
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            speakerOccurrenceId: {
              type: "string",
              enum: scene.occurrences.map((o) => o.id),
            },
            sourceUnitIds: unitSchema,
            text: { type: "string" },
          },
          required: ["id", "speakerOccurrenceId", "sourceUnitIds", "text"],
          additionalProperties: false,
        },
      },
    },
    required: ["sceneId", "sourceUnitIds", "utterances"],
    additionalProperties: false,
  };
  const context = {
    sceneId: scene.id,
    allowedSource: units.map((u) => ({ id: u.id, text: u.text })),
    speakers: scene.occurrences.map((o) => ({
      id: o.id,
      name: snapshot.cast.find((r) => r.id === o.roleBindingId)?.name,
      presence: o.presence,
      temporalStateRef: o.temporalStateRef,
      knowledgeStateRef: o.knowledgeStateRef,
      presentation: scene.presentations.find((p) => p.occurrenceId === o.id),
    })),
    existingUtteranceIds: scene.utterances.map((u) => u.id),
  };
  return generationCommand(snapshot, {
    kind: "text",
    target: { kind: "scene", id: scene.id },
    input: {
      model,
      prompt: `Create a cited scene script proposal in ${snapshot.project.language}. Use only allowed source and declared speakers. Do not add knowledge or facts absent from the selected source; state labels are not evidence. Assign new unique stable IDs matching [A-Za-z0-9_-]{1,120}; never reuse existing IDs. Each line must cite supplied source IDs. Return JSON only.\nCreator direction: ${direction}\n${JSON.stringify(context)}`,
      config: { schema },
    },
    recipe: { operation: "scene_adaptation_proposal" },
    estimateMicros,
  });
}
export function renderStory(c) {
  const s = c.snapshot,
    production = selectedProduction(c),
    scene = chosenScene(c),
    root = el("div", { class: "workspace-grid" }),
    left = el("div"),
    right = el("div");
  left.append(
    card(
      "원고와 자료",
      note(
        "원문은 가져온 바이트 그대로 고정합니다. 각색과 원작은 별도로 보관합니다.",
      ),
      form(
        c,
        "manuscript-import",
        [
          { name: "title", label: "자료 이름", required: true },
          {
            name: "file",
            label: "UTF-8 원고 파일",
            type: "file",
            accept: ".txt,.md,text/plain,text/markdown",
          },
          {
            name: "text",
            label: "직접 입력한 원고",
            type: "textarea",
            help: "파일을 선택하면 파일 원본을 사용합니다.",
          },
        ],
        async (p) => {
          const id = uid("source");
          const bytes = p.file
            ? new Uint8Array(await p.file.arrayBuffer())
            : new TextEncoder().encode(p.text);
          await c.send(
            command(s, "source.manuscript", "sourcePackage", id, {
              id,
              title: p.title,
              language: s.project.language,
              bytes: Array.from(bytes),
            }),
          );
        },
        { submit: "원문 고정하여 가져오기" },
      ),
    ),
  );
  if (c.api.bootstrap.sourceCapture.available)
    left.append(
      card(
        "연결 소설에서 가져오기",
        form(
          c,
          "source-capture",
          [
            { name: "workId", label: "작품 ID", required: true },
            {
              name: "chapters",
              label: "화 번호 (쉼표로 구분)",
              required: true,
            },
          ],
          async (p) => {
            const id = uid("source");
            await c.send(
              command(s, "source.capture", "sourcePackage", id, {
                id,
                workId: p.workId,
                request: {
                  kind: "novel-chapters",
                  chapters: p.chapters.split(",").map(Number),
                },
              }),
            );
          },
          { submit: "선택한 화 고정" },
        ),
      ),
    );
  for (const source of s.sourcePackages) {
    left.append(
      card(
        source.title ?? "고정된 원천",
        note(`${source.textUnits.length}개 원문 단위 · ${source.sourceKind}`),
        details("보존 상태", source.preservationStatus),
        ...source.textUnits.map((u) =>
          el(
            "details",
            {},
            el("summary", {}, u.title ?? u.id),
            el("pre", { class: "manuscript" }, u.text),
          ),
        ),
        production && production.sourcePackageId !== source.id
          ? button("이 제작판의 원천으로 검토", () =>
              c.run(async () => {
                await c.send(
                  command(s, "source.rebase", "sourceBinding", production.id, {
                    productionId: production.id,
                    sourcePackageId: source.id,
                    actor: "creator",
                    reason: "선택한 고정 원천으로 제작판 검토",
                  }),
                );
                await c.refresh(true);
              }),
            )
          : null,
      ),
    );
  }
  for (const change of s.sourceChanges.filter(
    (d) => d.productionId === production?.id && d.status === "pending",
  )) {
    const old = s.sourcePackages.find((p) => p.id === change.fromPackageId),
      next = s.sourcePackages.find((p) => p.id === change.toPackageId);
    right.append(
      card(
        "원천 교체 검토",
        el(
          "div",
          { class: "comparison" },
          details("이전 원문", old?.textUnits ?? []),
          details("새 원문", next?.textUnits ?? []),
        ),
        details("영향받는 장면과 작업", change),
        form(
          c,
          `rebase:${change.id}`,
          change.impacts.map((impact) => ({
            name: impact.sceneId,
            label:
              s.scenes.find((x) => x.id === impact.sceneId)?.title ??
              impact.sceneId,
            options: [
              { value: "", label: "선택하세요" },
              { value: "keep_override", label: "내 각색 유지" },
              { value: "replan", label: "다시 계획" },
              { value: "return_to_source", label: "원천으로 돌아가 재검토" },
            ],
            required: true,
          })),
          async (p, rev) =>
            c.send(
              command(
                s,
                "source.rebase",
                "sourceBinding",
                production.id,
                {
                  productionId: production.id,
                  decisionId: change.id,
                  action: "apply",
                  actor: "creator",
                  reason: "원문과 영향을 검토함",
                  choices: change.impacts.map((i) => ({
                    sceneId: i.sceneId,
                    action: p[i.sceneId],
                  })),
                },
                rev,
              ),
            ),
          {
            submit: "원천 변경 승인",
            revision: revision(s, "sourceBinding", production.id),
          },
        ),
        button("현재 원천 유지", () =>
          c.run(async () => {
            await c.send(
              command(s, "source.rebase", "sourceBinding", production.id, {
                productionId: production.id,
                decisionId: change.id,
                action: "keep_existing",
                actor: "creator",
                reason: "현재 원천 유지",
              }),
            );
            await c.refresh(true);
          }),
        ),
      ),
    );
  }
  right.append(
    card(
      "Studio 각색 노트",
      form(
        c,
        "story",
        [
          {
            name: "title",
            label: "각색 제목",
            value: s.story?.title ?? s.project.title,
            required: true,
          },
          {
            name: "text",
            label: "이야기와 공개 순서",
            type: "textarea",
            value: s.story?.text ?? "",
            required: true,
          },
        ],
        async (p, rev) =>
          c.send(
            command(
              s,
              "story.save",
              "story",
              s.story?.id ?? "story",
              {
                ...(s.story ?? {
                  id: "story",
                  states: [],
                  revealPolicy: { kind: "explicit-scene-selection" },
                }),
                ...p,
              },
              rev,
            ),
          ),
        {
          revision: revision(s, "story", s.story?.id ?? "story"),
          submit: "각색 노트 저장",
        },
      ),
    ),
  );
  if (s.story)
    right.append(
      card(
        "장면에서 구분할 상태",
        note(
          "시점·외형·목소리·지식 상태를 이름으로 정의한 뒤 Cast에서 각각 선택합니다.",
        ),
        el(
          "div",
          { class: "chips" },
          s.story.states.map((state) =>
            el("span", { class: "chip" }, state.name ?? state.id),
          ),
        ),
        form(
          c,
          "new-state",
          [{ name: "name", label: "상태 이름", required: true }],
          async (p, rev) =>
            c.send(
              command(
                s,
                "story.save",
                "story",
                s.story.id,
                {
                  ...s.story,
                  states: [
                    ...s.story.states,
                    { id: uid("state"), name: p.name },
                  ],
                },
                rev,
              ),
            ),
          { submit: "상태 추가", revision: revision(s, "story", s.story.id) },
        ),
      ),
    );
  if (production) {
    const source = s.sourcePackages.find(
      (p) => p.id === production.sourcePackageId,
    );
    right.append(
      card(
        scene ? "장면 목적과 원문" : "첫 장면",
        form(
          c,
          `scene:${scene?.id ?? production.id}`,
          [
            {
              name: "title",
              label: "장면 제목",
              value: scene?.title ?? "",
              required: true,
            },
            {
              name: "purpose",
              label: "목적 · 압력 · 변화",
              type: "textarea",
              value: scene?.purpose ?? "",
            },
            {
              name: "units",
              label: "허용할 원문 범위",
              help: "여러 항목을 함께 선택할 수 있습니다. 선택하지 않으면 원문 없이 수동 작업합니다.",
              multiple: true,
              value: scene?.sourceUnitIds ?? [],
              options: [
                { value: "", label: "원문 없이 수동 작업" },
                ...(source?.textUnits ?? []).map((u) => ({
                  value: u.id,
                  label: (u.title ?? u.text).slice(0, 45),
                })),
              ],
            },
          ],
          async (p, rev) => {
            const id = scene?.id ?? uid("scene");
            await c.send(
              command(
                s,
                "scene.put",
                "scene",
                id,
                {
                  ...(scene ?? {
                    id,
                    productionId: production.id,
                    occurrences: [],
                    presentations: [],
                    utterances: [],
                    shots: [],
                  }),
                  title: p.title,
                  purpose: p.purpose,
                  sourcePackageId: production.sourcePackageId,
                  sourceUnitIds: p.units,
                },
                rev,
              ),
            );
            c.selection.scene = id;
          },
          {
            submit: scene ? "장면 저장" : "장면 만들기",
            revision: scene ? revision(s, "scene", scene.id) : 0,
          },
        ),
        scene
          ? button("새 장면 작성", () => {
              c.selection.scene = "";
              c.persist();
              c.render();
            })
          : null,
      ),
    );
  }
  if (scene) {
    const google = c.api.bootstrap.providers?.find(
      (p) => p.provider === "google",
    );
    right.append(
      card(
        "원문에서 장면 대본 제안",
        note(
          "선택한 원문과 선언된 화자만 사용합니다. 제안 전문을 검토한 뒤 장면에 추가할 수 있습니다.",
        ),
        google?.available
          ? form(
              c,
              `adapt:${scene.id}`,
              [
                {
                  name: "direction",
                  label: "각색 방향",
                  type: "textarea",
                  value: scene.purpose ?? "",
                  required: true,
                },
                {
                  name: "model",
                  label: "모델",
                  options: google.catalog.text.map((m) => ({
                    value: m,
                    label: m,
                  })),
                },
                {
                  name: "estimate",
                  label: "예약 추정액 (USD)",
                  type: "number",
                  min: 0,
                  step: "0.01",
                  required: true,
                },
              ],
              async (p) =>
                c.send(
                  sceneAdaptationRequest(s, scene, {
                    model: p.model,
                    direction: p.direction,
                    estimateMicros: Math.round(Number(p.estimate) * 1e6),
                  }),
                ),
              { submit: "대본 제안 요청" },
            )
          : note(
              "Google 생성이 설정되지 않았습니다. Edit에서 대사를 직접 작성할 수 있습니다.",
            ),
      ),
    );
    const proposals = s.candidates.filter(
      (p) => p.mediaKind === "text" && p.sceneId === scene.id,
    );
    for (const candidate of proposals) {
      const p = candidate.proposal;
      right.append(
        card(
          proposalApplied(s, candidate)
            ? "각색 제안 · 적용됨"
            : "각색 제안 · 검토 대기",
          note(
            "내용 충실도는 사람이 검토해야 합니다. 원문 인용 범위만 기계 검증했습니다.",
          ),
          ...(p.utterances ?? [p]).map((u) =>
            el(
              "div",
              { class: "script-line" },
              el(
                "strong",
                {},
                s.cast.find(
                  (r) =>
                    r.id ===
                    scene.occurrences.find(
                      (o) => o.id === u.speakerOccurrenceId,
                    )?.roleBindingId,
                )?.name ?? u.speakerOccurrenceId,
              ),
              el("p", {}, u.text),
              note(`근거 · ${u.sourceUnitIds.join(", ")}`),
            ),
          ),
          details("제안 원본과 검사", candidate),
          proposalApplied(s, candidate)
            ? note(
                "검토한 대본을 장면에 적용했습니다. 원본 제안은 그대로 보관합니다.",
              )
            : form(
                c,
                `proposal:${candidate.id}`,
                [{ name: "reason", label: "검토 메모", required: true }],
                async (patch, rev) =>
                  c.send(
                    command(
                      s,
                      "proposal.apply",
                      p.utterances ? "scene" : "utterance",
                      p.utterances ? scene.id : p.utteranceId,
                      {
                        candidateId: candidate.id,
                        ...(p.utterances
                          ? { sceneId: scene.id }
                          : { utteranceId: p.utteranceId }),
                        actor: "creator",
                        reason: patch.reason,
                      },
                      rev,
                    ),
                  ),
                {
                  submit: p.utterances
                    ? "검토한 대본을 장면에 추가"
                    : "검토한 발화 적용",
                  revision: revision(
                    s,
                    p.utterances ? "scene" : "utterance",
                    p.utterances ? scene.id : p.utteranceId,
                  ),
                },
              ),
        ),
      );
    }
  }
  root.append(left, right);
  return root;
}
