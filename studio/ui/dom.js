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
export const details = (label, value) =>
  el(
    "details",
    {},
    el("summary", {}, label),
    el(
      "pre",
      {},
      typeof value === "string" ? value : JSON.stringify(value, null, 2),
    ),
  );
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
  { submit = "저장", revision = 0, description = null } = {},
) {
  const previous = c.drafts.get(key);
  const controls = new Map();
  const body = el("form", { class: "form" });
  if (description) body.append(note(description));
  for (const field of fields) {
    const val = previous?.value[field.name] ?? field.value ?? "";
    let input;
    if (field.options)
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
    controls.set(field.name, input);
    body.append(
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
  body.addEventListener("input", () => {
    const serial = values();
    for (const f of fields.filter((f) => f.type === "file"))
      delete serial[f.name];
    c.drafts.set(key, serial, previous?.revision ?? revision);
    c.persist();
  });
  const submitButton = el(
    "button",
    { type: "submit", class: "primary" },
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
      submitButton.disabled = false;
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
