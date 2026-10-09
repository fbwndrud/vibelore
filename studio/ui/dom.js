export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (value !== null && value !== undefined) {
      if (key in node && !key.startsWith("aria-")) node[key] = value;
      else node.setAttribute(key, String(value));
    }
  }
  for (const child of children.flat(Infinity))
    if (child != null)
      node.append(
        child instanceof Node ? child : document.createTextNode(String(child)),
      );
  return node;
}
export const button = (text, action, attrs = {}) =>
  el("button", { type: "button", onclick: action, ...attrs }, text);
export const note = (text) => el("p", { class: "muted" }, text);
export const card = (title, ...children) =>
  el("section", { class: "card" }, el("h2", {}, title), ...children);
const recordNames = { request:'요청 내용', input:'선택 입력', config:'생성 설정', model:'모델', voice:'목소리', acting:'연기 지시', prompt:'생성 지시', status:'상태', httpStatus:'HTTP 응답', providerFailure:'서비스 오류', operationId:'서비스 응답 ID', provider:'생성 서비스', kind:'종류', title:'제목', reason:'선택 이유', text:'대사', name:'이름', revision:'변경판', sourceUnitIds:'원문 근거', validation:'자료 검사', scope:'적용 범위', subject:'대상', mediaKind:'자료 종류', label:'자료 이름', resolvedModel:'확인된 모델', returnedModel:'반환된 모델', returnedVoice:'반환된 목소리', usage:'사용량', reservation:'예약과 청구', createdAt:'기록 시간', requestedModel:'요청 모델', amountKind:'금액 근거', estimateMicros:'예약 추정액 (백만분의 달러)', settledMicros:'정산 기록 (백만분의 달러)' };
function recordView(value) {
  if (value == null) return el('span', { class:'muted' }, '없음 / 미확인');
  if (typeof value !== 'object') return el('span', { class:'record-value' }, value === true ? '예' : value === false ? '아니오' : String(value));
  const rows = Object.entries(value);
  if (!rows.length) return note('등록된 항목 없음');
  return el('dl', { class:'record-fields' }, rows.map(([key,v]) => [el('dt',{}, Array.isArray(value) ? `${Number(key)+1}번` : recordNames[key] ?? key), el('dd',{}, typeof v === 'object' && v != null ? el('details',{},el('summary',{}, `${Object.keys(v).length}개 항목 보기`),recordView(v)) : recordView(v))]));
}
export const details = (label, value) => el('details', {}, el('summary', {}, label), typeof value === 'string' ? el('p', { class:'record-value' }, value) : recordView(value));
export const suggestedCard = (title, intro, editor, suggestions, ...rest) => card(title, intro, suggestions, editor, ...rest);
export function select(label, value, options, onchange) {
  return el(
    "label",
    { class: "field" },
    el("span", {}, label),
    el(
      "select",
      { value, onchange: (e) => onchange(e.target.value) },
      options.map((o) =>
        el("option", { value: o.value, selected: o.value === value }, o.label),
      ),
    ),
  );
}
export const options = (items, label = "title") =>
  items.map((x) => ({ value: x.id, label: x[label] ?? x.id }));
export const uid = (prefix) => `${prefix}-${crypto.randomUUID()}`;
export function form(
  c,
  key,
  fields,
  onSubmit,
  { submit = "저장", revision = 0, description = null, onDraft = null, disabled = false, id = null } = {},
) {
  const previous = c.drafts.get(key);
  const controls = new Map();
  const body = el("form", { class: "form", id });
  let advanced;
  if (description) body.append(note(description));
  for (const field of fields) {
    const originalValue = previous?.value[field.name] ?? field.value ?? "";
    const val = field.normalize ? field.normalize(originalValue) : originalValue;
    let input;
    if (field.render) input = field.render(val);
    else if (field.options)
      input = el(
        "select",
        {
          name: field.name,
          multiple: Boolean(field.multiple),
          ...(field.multiple
            ? { size: Math.min(5, Math.max(2, field.options.length)) }
            : {}),
        },
        field.options.map((o) =>
          el(
            "option",
            {
              value: o.value,
              selected: field.multiple
                ? (Array.isArray(val) ? val : [val]).includes(o.value)
                : String(val) === String(o.value),
            },
            o.label,
          ),
        ),
      );
    else
      input = el(field.type === "textarea" ? "textarea" : "input", {
        name: field.name,
        ...(field.type === "textarea" ? {} : { type: field.type ?? "text" }),
        value: field.type === "file" ? "" : val,
        required: field.required ?? false,
        ...(field.accept ? { accept: field.accept } : {}),
        ...(field.min !== undefined ? { min: field.min } : {}),
        ...(field.max !== undefined ? { max: field.max } : {}),
        ...(field.step ? { step: field.step } : {}),
      });
    input.name = field.name;
    controls.set(field.name, input);
    if (field.advanced && !advanced) {
      advanced = el('details', { class: 'advanced-fields' }, el('summary', {}, '세부 구도·안전 영역'));
      body.append(advanced);
    }
    (field.advanced ? advanced : body).append(
      el(
        "label",
        { class: "field" },
        el("span", {}, field.label),
        input,
        field.help ? note(field.help) : null,
      ),
    );
  }
  const values = () =>
    Object.fromEntries(
      [...controls].map(([name, input]) => [
        name,
        input.type === "file"
          ? input.files[0]
          : input.multiple
            ? Array.from(
                input.selectedOptions,
                (option) => option.value,
              ).filter(Boolean)
            : input.value,
      ]),
    );
  const draftValues = () => {
    const serial = values();
    for (const field of fields) {
      if (field.type === 'file') delete serial[field.name];
      else if (field.serializeDraft) serial[field.name] = field.serializeDraft(serial[field.name]);
    }
    return serial;
  };
  body.getDraftValues = values;
  body.setDraftPatch = patch => {
    for (const [name, value] of Object.entries(patch)) if (controls.has(name)) controls.get(name).value = value;
    const serial = draftValues();
    c.drafts.set(key, serial, previous?.revision ?? revision);
    c.persist();
    onDraft?.(serial);
  };
  body.addEventListener("input", () => {
    const serial = draftValues();
    c.drafts.set(key, serial, previous?.revision ?? revision);
    c.persist();
    onDraft?.(serial);
  });
  const submitButton = el(
    "button",
    { type: "submit", class: "primary", disabled },
    submit,
  );
  body.append(
    el(
      "div",
      { class: "actions" },
      submitButton,
      button(
        "저장 내용으로 되돌리기",
        () => {
          c.drafts.delete(key);
          c.persist();
          c.render();
        },
        { class: "quiet" },
      ),
    ),
  );
  const error = el("p", { class: "error", role: "alert" });
  body.append(error);
  body.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (disabled) return;
    submitButton.disabled = true;
    error.textContent = "";
    try {
      await onSubmit(values(), c.drafts.get(key)?.revision ?? revision);
      c.drafts.delete(key);
      c.persist();
      await c.refresh(true);
      c.status("저장되었습니다.");
    } catch (e) {
      error.textContent =
        e.code === "REVISION_CONFLICT"
          ? "다른 변경이 저장되었습니다. 입력 초안은 남아 있습니다. 저장된 내용을 불러와 비교한 뒤 다시 편집하세요."
          : `저장하지 못했습니다 · ${e.code ?? e.message}`;
      c.status(error.textContent);
    } finally {
      submitButton.disabled = disabled;
    }
  });
  return body;
}
export function chosenScene(c) {
  return c.snapshot.scenes.find((s) => s.id === c.selection.scene);
}
export function selectedProduction(c) {
  return c.snapshot.productions.find((p) => p.id === c.selection.production);
}
export const stateOptions = (c) => [
  { value: "", label: "지정하지 않음" },
  ...options(c.snapshot.story?.states ?? [], "name"),
];
export const nullish = (value) => value || null;
export function media(c, candidate, label) {
  const host = el("figure", { class: "media" }, el("figcaption", {}, label));
  if (!candidate) {
    host.append(note("아직 채택한 자료가 없습니다."));
    return host;
  }
  c.api
    .blob(candidate)
    .then((url) => {
      if (!host.isConnected) {
        URL.revokeObjectURL(url);
        return;
      }
      c.urls.add(url);
      const node = el(candidate.mediaKind === "audio" ? "audio" : "img", {
        src: url,
        ...(candidate.mediaKind === "audio"
          ? { controls: true }
          : { alt: label }),
      });
      host.append(node);
    })
    .catch(() => host.append(note("자료를 불러오지 못했습니다.")));
  return host;
}

const scopes = { project: "작품 공통", production: "제작판", scene: "장면", shot: "샷" };
export function assetSlotLabel(snapshot, slot) {
  const asset = snapshot.sourcePackages?.flatMap(p => p.assets ?? []).find(a => a.id === slot.id);
  const scene = snapshot.scenes.find(s => s.id === slot.subject.id);
  const role = snapshot.cast.find(r => r.id === slot.subject.id || r.characterId === slot.subject.id);
  const subject = scene?.title ?? role?.name ?? (slot.subject.kind === "environment" ? "배경 / 공간" : slot.subject.id);
  return `${slot.mediaKind === "audio" ? "음성" : "그림"} · ${subject} · ${asset?.label ?? slot.id} · ${scopes[slot.scope.kind]}`;
}
export function slotInContext(slot, snapshot, scene = null, shotId = null, productionId = scene?.productionId) {
  if (slot.scope.kind === "project") return slot.scope.id === snapshot.project.id;
  if (!productionId && !scene) return true;
  if (slot.scope.kind === "production") return slot.scope.id === productionId;
  if (slot.scope.kind === "scene") return slot.scope.id === scene?.id;
  return slot.scope.kind === "shot" && slot.scope.id === shotId;
}
