import { renderAssetLab } from './asset-lab.js';
import { renderHistory, goToWork } from './workflow.js';
import { keyframeEditor, cameraSuggestions, actingText, actingSuggestions, legacyActing } from './camera.js';
import { renderPreview, renderWorkingShot } from "./player.js";
import { command, revision, utteranceCommand } from "./api.js";
import { assetSlotLabel, slotInContext } from "./dom.js";
import {
  el,
  button,
  card,
  suggestedCard,
  note,
  form,
  select,
  options,
  uid,
  chosenScene,
  details,
  media,
} from "./dom.js";
export function shotCommand(
  snapshot,
  sceneId,
  shotId,
  patch,
  expectedRevision = revision(snapshot, "scene", sceneId),
) {
  const scene = structuredClone(snapshot.scenes.find((s) => s.id === sceneId));
  const index = scene.shots.findIndex((sh) => sh.id === shotId);
  const shot = { ...(scene.shots[index] ?? { id: shotId }), ...patch };
  if (index < 0) scene.shots.push(shot);
  else scene.shots[index] = shot;
  return command(
    snapshot,
    "scene.put",
    "scene",
    sceneId,
    scene,
    expectedRevision,
  );
}
function renderEditors(c, { script = false } = {}) {
  const s = c.snapshot,
    scene = chosenScene(c);
  if (!scene)
    return card(
      "장면을 선택하세요",
      note("Story에서 장면을 만든 뒤 대사와 샷을 편집할 수 있습니다."),
    );
  const root = el("div", { class: "workspace-grid" });
  const left = el("div"),
    right = el("div");
  const u =
    scene.utterances.find((u) => u.id === c.selection.utterance) ??
    scene.utterances[0];
  if (u) { c.selection.utterance = u.id; c.selection.occurrence = u.speakerOccurrenceId; }
  const shot = scene.shots.find((sh) => sh.id === c.selection.shot) ?? scene.shots[0];
  if (shot) c.selection.shot = shot.id;
  const workingShot = shot && !script ? renderWorkingShot(c, scene, shot) : null;
  if (workingShot) left.append(workingShot.root);
  if (!script) left.append(renderPreview(c));
  if (u) {
    const originalActingText = actingText(u.acting);
    const previousActing = legacyActing(c.drafts.get(`utterance:${u.id}`)?.value.acting);
    let actingForm;
    const occurrence = scene.occurrences.find(
      (o) => o.id === u.speakerOccurrenceId,
    );
    const role = s.cast.find((r) => r.id === occurrence.roleBindingId);
    right.append(
      card(
        "발화 연기",
        select(
          "발화 선택",
          u.id,
          scene.utterances.map((u) => ({
            value: u.id,
            label: u.text.slice(0, 45),
          })),
          (id) => {
            selectCue(c,scene,id);
          },
        ),
        note(`${role?.name} · ${{onscreen:'화면 속',narrator:'해설',offscreen:'화면 밖',voiceover:'보이스오버',internal:'속마음',crowd:'군중'}[occurrence.presence] ?? '출현'} · 이 발화만 저장`),
        actingForm = form(
          c,
          `utterance:${u.id}`,
          [
            {
              name: "text",
              label: "대사",
              type: "textarea",
              value: u.text,
              required: true,
            },
            {
              name: "acting",
              label: "연기 지시",
              normalize: v => actingText(legacyActing(v)),
              serializeDraft: v => previousActing && typeof previousActing === 'object' && v === actingText(previousActing) ? previousActing : v === originalActingText ? u.acting ?? '' : v,
              type: "textarea",
              value:
                originalActingText,
            },
            {
              name: "holdMs",
              label: "대답 전 기다림 (밀리초)",
              type: "number",
              value: u.holdMs ?? 0,
              min: 0,
            },
            { name: "intent", label: "말하는 목적", value: u.intent ?? "" },
            { name: "subtext", label: "속뜻", value: u.subtext ?? "" },
          ],
          async (p, rev) =>
            c.send(
              utteranceCommand(
                s,
                u.id,
                Object.fromEntries(
                  Object.entries({
                    ...p,
                    acting: previousActing && typeof previousActing === "object" && p.acting === actingText(previousActing) ? previousActing : p.acting === originalActingText ? u.acting ?? "" : p.acting,
                    holdMs: Number(p.holdMs),
                  }).filter(
                    ([key, value]) => !(value === "" && u[key] == null),
                  ),
                ),
                rev,
              ),
            ),
          { revision: revision(s, "utterance", u.id), submit: "이 발화 저장" },
        ),
        actingSuggestions(actingForm),
        note(`적용 목소리 · ${s.resolvedBindings.find(b => b.occurrenceId === occurrence.id)?.casting?.voice ?? '미배정'} · Cast에서 변경`),
        details(
          "출현과 목소리 해석",
          s.resolvedBindings.filter((b) => b.occurrenceId === occurrence.id),
        ),
      ),
    );
    const takes = s.candidates.filter(
      (x) =>
        x.mediaKind === "audio" &&
        (x.utteranceId === u.id ||
          x.target.id === u.id ||
          x.slotIntent?.utteranceId === u.id),
    );
    left.append(
      card(
        "실제 음성 테이크",
        note(
          "파일 재생으로 비교하세요. 가져온 음원의 대사와 목소리는 자동 검증되지 않습니다.",
        ),
        takes.length
          ? takes.map((t) => media(c, t, t.id.slice(0, 16)))
          : note("가져오거나 생성한 음원이 없습니다."),
      ),
    );
  }
  right.append(
    card(
      "발화 추가",
      form(
        c,
        `new-utterance:${scene.id}`,
        [
          {
            name: "speaker",
            label: "화자 출현",
            options: scene.occurrences.map((o) => ({
              value: o.id,
              label: `${s.cast.find((r) => r.id === o.roleBindingId)?.name} · ${o.presence}`,
            })),
          },
          { name: "text", label: "대사", type: "textarea", required: true },
        ],
        async (p, rev) => {
          const id = uid("utterance");
          await c.send(
            command(
              s,
              "scene.put",
              "scene",
              scene.id,
              {
                ...scene,
                utterances: [
                  ...scene.utterances,
                  {
                    id,
                    speakerOccurrenceId: p.speaker,
                    addresseeOccurrenceIds: [],
                    text: p.text,
                    holdMs: 0,
                  },
                ],
              },
              rev,
            ),
          );
          c.selection.utterance = id;
        },
        { revision: revision(s, "scene", scene.id), submit: "발화 추가" },
      ),
    ),
  );
  if (script) return { left, right, scene, u, shot };
  const sh = shot ?? { id: uid("shot") },
    tr = sh.transform ?? {};
  let cameraForm;
  right.append(
    suggestedCard(
      shot ? "샷 연출" : "새 샷",
      note("카메라 의도 저장은 이미지·음성 생성 비용이 없습니다."),
      cameraForm = form(
        c,
        `shot:${scene.id}:${shot?.id ?? "new"}`,
        [
          { name: "title", label: "샷 이름", value: sh.title ?? "" },
          {
            name: "intent",
            label: "의도",
            value: sh.intent ?? "wide",
            options: ["wide", "close", "reaction", "insert"].map((v) => ({
              value: v,
              label: { wide: '전체 공간', close: '인물 가까이', reaction: '반응', insert: '소품 / 디테일' }[v],
            })),
          },
          {
            name: "target",
            label: "화면 속 대상",
            value: sh.targetOccurrenceId ?? "",
            options: [
              { value: "", label: "특정 인물 없음" },
              ...scene.occurrences
                .filter((o) => o.presence === "onscreen")
                .map((o) => ({
                  value: o.id,
                  label:
                    s.cast.find((r) => r.id === o.roleBindingId)?.name ?? o.id,
                })),
            ],
          },
          {
            name: "prop",
            advanced: true,
            label: "소품 대상 (선택)",
            value: sh.propTarget ?? "",
          },
          {
            name: "referenceSlotId",
            label: "참조 이미지 슬롯",
            value: sh.referenceSlotId ?? "",
            options: [
              { value: "", label: "아직 없음" },
              ...s.slots.filter(x => x.mediaKind === "image" && slotInContext(x, s, scene, shot?.id))
                .map(x => ({ value: x.id, label: assetSlotLabel(s, x) })),
            ],
          },
          ...["x", "y", "scale"].map((name) => ({
            name,
            advanced: true,
            label: {
              x: "가로 이동",
              y: "세로 이동",
              scale: "확대 배율",
            }[name],
            type: "number",
            step: "0.01",
            value: tr[name] ?? (name === "scale" ? 1 : 0),
          })),
          ...["Left", "Top", "Right", "Bottom"].map((edge) => ({
            name: `safeArea${edge}`,
            advanced: true,
            label: `안전 영역 · ${{ Left: "왼쪽", Top: "위쪽", Right: "오른쪽", Bottom: "아래쪽" }[edge]}`,
            type: "number",
            min: 0,
            max: 0.5,
            step: "0.01",
            value: tr.safeArea?.[edge.toLowerCase()] ?? 0,
          })),
          {
            name: "anchor",
            advanced: true,
            label: "기준점",
            value: tr.anchor ?? "center",
            options: ["center", "top", "bottom"].map((v) => ({
              value: v,
              label: { center: '중앙', top: '위쪽', bottom: '아래쪽' }[v],
            })),
          },
          {
            name: "easing",
            advanced: true,
            label: "이동 곡선",
            value: tr.easing ?? "linear",
            options: ["linear", "ease-in-out"].map((v) => ({
              value: v,
              label: { linear: '일정한 속도', 'ease-in-out': '부드럽게 시작·끝' }[v],
            })),
          },
          {
            name: "keyframes",
            label: "시간별 카메라 위치",
            render: keyframeEditor,
            value: JSON.stringify(tr.keyframes ?? []),
            help: "시점 사이의 이동은 선택한 이동 곡선을 따릅니다.",
          },
        ],
        async (p, rev) => {
          await c.send(
            shotCommand(
              s,
              scene.id,
              sh.id,
              {
                title: p.title,
                intent: p.intent,
                targetOccurrenceId: p.target || null,
                propTarget: p.prop || null,
                referenceSlotId: p.referenceSlotId || null,
                transform: {
                  x: Number(p.x),
                  y: Number(p.y),
                  scale: Number(p.scale),
                  safeArea: {
                    left: Number(p.safeAreaLeft),
                    top: Number(p.safeAreaTop),
                    right: Number(p.safeAreaRight),
                    bottom: Number(p.safeAreaBottom),
                  },
                  anchor: p.anchor,
                  easing: p.easing,
                  keyframes: JSON.parse(p.keyframes),
                },
              },
              rev,
            ),
          );
          c.selection.shot = sh.id;
        },
        { revision: revision(s, "scene", scene.id), submit: "샷 연출 저장", onDraft: workingShot?.update },
      ),
      cameraSuggestions(cameraForm, tr),
    ),
  );
  return { left, right, scene, u, shot, workingShot };
}

// A scene may have several cues by one speaker. Index pairing is valid only
// when the scene explicitly has one shot per cue with a matching occurrence.
function matchesCue(scene, shot, u) {
  if (!shot || !u) return false;
  if (shot.targetOccurrenceId != null) return shot.targetOccurrenceId === u.speakerOccurrenceId;
  return scene.occurrences.find(o=>o.id===u.speakerOccurrenceId)?.presence !== 'onscreen';
}
export function selectCue(c, scene, utteranceId) {
  const index = scene.utterances.findIndex(u => u.id === utteranceId);
  if (index < 0) return;
  const u = scene.utterances[index];
  Object.assign(c.selection, { scene: scene.id, utterance: u.id, occurrence: u.speakerOccurrenceId });
  const paired = scene.shots.length === scene.utterances.length && matchesCue(scene,scene.shots[index],u);
  const shot = paired ? scene.shots[index] : scene.shots.find(sh => sh.targetOccurrenceId === u.speakerOccurrenceId);
  if (shot) c.selection.shot = shot.id;
  c.persist(); c.render();
}
export function selectShot(c, scene, shotId) {
  const index = scene.shots.findIndex(sh => sh.id === shotId);
  if (index < 0) return;
  const shot = scene.shots[index];
  const paired = scene.shots.length === scene.utterances.length && matchesCue(scene,shot,scene.utterances[index]);
  const current = scene.utterances.find(u => u.id === c.selection.utterance && u.speakerOccurrenceId === shot.targetOccurrenceId);
  const u = paired ? scene.utterances[index] : current ?? scene.utterances.find(u => u.speakerOccurrenceId === shot.targetOccurrenceId);
  c.selection.shot = shot.id;
  if (u) Object.assign(c.selection,{utterance:u.id,occurrence:u.speakerOccurrenceId});
  c.persist(); c.render();
}
function cueRole(s, scene, u) {
  const occurrence = scene.occurrences.find(o => o.id === u.speakerOccurrenceId);
  const role = s.cast.find(r => r.id === occurrence?.roleBindingId);
  const voice = s.resolvedBindings.find(b => b.occurrenceId === occurrence?.id && !b.shotId)?.casting?.voice;
  return { name:role?.name ?? '화자', voice:voice ?? '목소리 미배정' };
}
function cueSequence(c, scene, screenplay = false) {
  const list = el('div',{class:screenplay?'screenplay-cues':'cue-timeline','aria-label':screenplay?'장면 대본':'장면 발화 순서'});
  for (const [i,u] of scene.utterances.entries()) {
    const role = cueRole(c.snapshot,scene,u);
    const draft = c.drafts.get(`utterance:${u.id}`)?.value;
    const row = button([
      el('span',{class:'cue-number'},String(i+1).padStart(2,'0')),
      el('span',{class:'cue-speaker'},el('strong',{},role.name),el('small',{},role.voice)),
      el('span',{class:'cue-content'},el('span',{class:'cue-dialogue'},draft?.text ?? u.text),
        screenplay ? el('small',{},draft ? '편집 초안 있음' : actingText(u.acting)) : null),
      el('small',{class:'cue-status'},`${(u.holdMs??0)/1000}초 침묵 · ${c.snapshot.slots.some(slot=>slot.mediaKind==='audio'&&slot.utteranceId===u.id&&slot.candidateId)?'음원 채택됨':'음원 미준비'}`),
    ],()=>selectCue(c,scene,u.id),{'aria-label':`발화 ${i+1} 편집`,'aria-pressed':c.selection.utterance===u.id,class:c.selection.utterance===u.id?'cue-row selected':'cue-row'});
    list.append(row);
  }
  return list;
}
export function renderScript(c) {
  const editors = renderEditors(c,{script:true});
  if (!editors.scene) return editors;
  const {scene,right} = editors;
  const page = el('section',{class:'screenplay-view'},
    el('main',{class:'screenplay-paper'},el('h2',{},scene.title??'장면 대본'),note('화자를 선택해 연기와 응답 간격을 다듬습니다. 편집 초안은 연출 화면에서도 이어집니다.'),cueSequence(c,scene,true)),
    el('aside',{class:'screenplay-inspector'},...Array.from(right.children)));
  return page;
}
export function renderEdit(c) {
  const editors = renderEditors(c);
  if (!editors.scene) return editors;
  const {scene,u,shot,left,right,workingShot} = editors;
  const center = el('main',{class:'director-stage'},
    workingShot?.root ?? card('샷 구도',note('왼쪽에서 샷을 선택하거나 새 샷을 만드세요.')),
    el('section',{class:'sequence-panel'},el('div',{class:'sequence-heading'},el('h2',{},'장면 타임라인'),note('발화 순서 · 실제 음원 준비 후 재생 시간 확정')),cueSequence(c,scene)));
  const preview = Array.from(left.children).find(node=>node!==workingShot?.root);
  if (preview) center.append(el('details',{class:'review-disclosure'},el('summary',{},'고정 미리보기·출력'),preview));
  const voice = el('div',{class:'inspector-panel'});
  if (u) voice.append(right.children[0]);
  const takes = Array.from(left.children).at(-1);
  if (u && takes && takes!==preview && takes!==workingShot?.root) voice.append(takes);
  voice.append(button('이 발화의 음성 준비',()=>goToWork(c,'assets',{assetKind:'audio',slot:'',candidate:''}),{class:'quiet'}));
  const camera = Array.from(right.children).at(-1);
  const inspector = el('aside',{class:'director-inspector'},el('h2',{},shot?.title??'새 샷'));
  const tabs = el('div',{'aria-label':'샷 편집 도구',class:'inspector-tabs'});
  const host = el('div',{class:'inspector-content'});
  const panels = new Map([['camera',el('section',{class:'inspector-panel'},camera)],['voice',voice]]);
  host.append(...panels.values());
  const modes=[['camera','연출'],['voice','대사·음성'],['image','그림'],['history','이력']];
  function display(mode) {
    c.selection.inspector=mode;c.persist();
    for (const b of tabs.children) b.setAttribute('aria-pressed',String(b.dataset.mode===mode));
    if(mode==='image' && !panels.has(mode)) {
      const imageContext = Object.create(c);
      const imageKey = `${scene.id}:${shot?.id??'new'}`;
      const sameImage = c.selection.imageInspectorShot===imageKey && c.selection.assetKind==='image';
      imageContext.selection = {...c.selection,assetKind:'image',slot:sameImage?c.selection.slot:shot?.referenceSlotId??'',candidate:sameImage?c.selection.candidate:'',imageInspectorShot:imageKey};
      // Asset actions keep the shared selection; the initial embedded view alone
      // is scoped to the selected shot. Mutations still use the normal authority.
      imageContext.persist=()=>{
        if ((c.selection.workspace && c.selection.workspace!=='edit') || c.selection.scene!==scene.id || c.selection.shot!==shot?.id || c.selection.inspector!=='image') return;
        for (const key of ['assetKind','slot','candidate','imageInspectorShot']) c.selection[key]=imageContext.selection[key];
        c.persist();
      };
      imageContext.render=()=>{imageContext.persist();c.render();};
      imageContext.persist();
      const panel = el('section',{class:'inspector-panel'},renderAssetLab(imageContext));
      panels.set(mode,panel);host.append(panel);
    } else if(mode==='history' && !panels.has(mode)) {
      const panel = el('section',{class:'inspector-panel'},renderHistory(c));panels.set(mode,panel);host.append(panel);
    }
    for (const [key,panel]of panels) panel.hidden=key!==mode;
  }
  for(const [mode,label]of modes) tabs.append(button(label,()=>display(mode),{'data-mode':mode}));
  inspector.append(tabs,host);display(c.selection.inspector??'camera');
  return el('div',{class:'director-view'},center,inspector);
}
