import { command, revision } from './api.js';
import {
  el,
  button,
  card,
  note,
  form,
  uid,
  chosenScene,
  assetSlotLabel,
  slotInContext,
} from './dom.js';

const number = (name, label, value, extra = {}) => ({
  name,
  label,
  type: 'number',
  value,
  ...extra,
});
const acceptedImages = (c, scene, shot) =>
  c.snapshot.slots.filter(
    (slot) =>
      slot.mediaKind === 'image' &&
      slot.candidateId &&
      slotInContext(slot, c.snapshot, scene, shot.id),
  );
function layerControls(value, c, scene, shot) {
  let layers = JSON.parse(value || '[]');
  const root = el('div', { class: 'layer-editor' });
  let readers = [];
  const imageChoices = (use) => acceptedImages(c, scene, shot).flatMap((slot) => {
    const role = c.snapshot.candidates.find((candidate) => candidate.id === slot.candidateId)?.reuseRole;
    // Match the retained-role guard in render/closure.js; unmarked native images
    // keep their legacy identity/state/adoption checks in the engine.
    const allowed = use === 'poseCue'
      ? ['pose']
      : slot.subject.kind === 'environment'
        ? ['environment-reference', 'final-scene']
        : ['identity-reference', 'pose'];
    return role && !allowed.includes(role) ? [] : [{
      value: slot.id,
      label: assetSlotLabel(c.snapshot, slot),
    }];
  });
  const imageOptions = imageChoices('layer'), poseOptions = imageChoices('poseCue');
  function read() {
    return readers.map((fn) => fn());
  }
  function changed() {
    redraw();
    root.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function redraw() {
    readers = [];
    root.replaceChildren();
    root.append(
      note('기본 인물 레이어는 identity-reference·pose, 배경은 environment-reference·final-scene, 포즈 전환은 pose 역할을 사용합니다.'),
      note('style-reference·edit-target은 참조 전용입니다. 역할 표기가 없는 기존 이미지는 기존 인물·상태 검사를 따릅니다.'),
    );
    if (!imageOptions.length)
      root.append(note('기본 레이어에 사용할 채택 이미지가 없습니다. 지원 역할의 이미지를 먼저 채택하세요.'));
    layers.forEach((layer, index) => {
      const box = card(`레이어 ${index + 1}`),
        controls = new Map();
      const field = (key, label, value, options) => {
        const choices = options && value && !options.some((option) => option.value === value)
          ? [{ value, label: `지원하지 않는 선택 · ${value} (역할·범위 확인)`, disabled: true }, ...options]
          : options;
        const input = choices
          ? el(
              'select',
              { name: `layer-${index}-${key}` },
              choices.map((o) =>
                el(
                  'option',
                  { value: o.value, selected: o.value === value, disabled: Boolean(o.disabled) },
                  o.label,
                ),
              ),
            )
          : el('input', {
              name: `layer-${index}-${key}`,
              type: typeof value === 'number' ? 'number' : 'text',
              step: 'any',
              value,
            });
        controls.set(key, input);
        box.append(
          el('label', { class: 'field' }, el('span', {}, label), input),
        );
        return input;
      };
      field('slotId', '채택한 이미지', layer.slotId, imageOptions);
      field('occurrenceId', '화면 속 인물', layer.occurrenceId ?? '', [
        { value: '', label: '배경 / 공간' },
        ...scene.occurrences
          .filter((o) => o.presence === 'onscreen')
          .map((o) => ({
            value: o.id,
            label:
              c.snapshot.cast.find((r) => r.id === o.roleBindingId)?.name ??
              o.id,
          })),
      ]);
      field('z', '그리기 순서', layer.z);
      for (const [key, label, fallback] of [
        ['anchorX', '가로 기준점', 0.5],
        ['anchorY', '세로 기준점', 0.5],
        ['x', '가로 이동량', 0],
        ['y', '세로 이동량', 0],
        ['scale', '크기', 1],
        ['rotation', '회전 (라디안)', 0],
        ['opacity', '불투명도', 1],
      ])
        field(
          key,
          label,
          key.startsWith('anchor')
            ? layer.anchor?.[key === 'anchorX' ? 'x' : 'y'] ?? fallback
            : layer.transform?.[key] ?? fallback,
        );
      const keyframes = (layer.keyframes ?? []).map((frame, i) => {
        const inputs = {};
        box.append(note(`움직임 ${i + 1} · 샷 상대 프레임, 속성별 선형 이동`));
        for (const key of ['frame', 'x', 'y', 'scale', 'rotation', 'opacity'])
          inputs[key] = field(`key-${i}-${key}`, key, frame[key] ?? '');
        return () =>
          Object.fromEntries(
            Object.entries(inputs)
              .filter(([, input]) => input.value !== '')
              .map(([key, input]) => [key, Number(input.value)]),
          );
      });
      const cues = (layer.poseCues ?? []).map((cue, i) => {
        const frame = field(`cue-${i}-frame`, '포즈 전환 프레임', cue.frame),
          slot = field(
            `cue-${i}-slot`,
            '전환할 채택 포즈',
            cue.slotId,
            poseOptions,
          ),
          expression = field(
            `cue-${i}-expression`,
            '표정 기록',
            cue.expression ?? '',
          ),
          gaze = field(`cue-${i}-gaze`, '시선 기록', cue.gaze ?? '');
        return () => ({
          frame: Number(frame.value),
          slotId: slot.value,
          ...(expression.value ? { expression: expression.value } : {}),
          ...(gaze.value ? { gaze: gaze.value } : {}),
        });
      });
      field('contact', '접촉 대상 레이어', layer.contact?.targetLayerId ?? '', [
        { value: '', label: '없음' },
        ...layers
          .filter((x) => x.id !== layer.id)
          .map((x) => ({ value: x.id, label: x.id })),
      ]);
      field(
        'contactX',
        '대상 이미지 가로 접촉점',
        layer.contact?.anchor.x ?? 0.5,
      );
      field(
        'contactY',
        '대상 이미지 세로 접촉점',
        layer.contact?.anchor.y ?? 0.5,
      );
      const v = (key) => controls.get(key).value,
        n = (key) => Number(v(key));
      readers.push(() => ({
        ...layer,
        slotId: v('slotId'),
        ...(v('occurrenceId')
          ? { occurrenceId: v('occurrenceId') }
          : { occurrenceId: undefined }),
        z: n('z'),
        anchor: { x: n('anchorX'), y: n('anchorY') },
        transform: Object.fromEntries(
          ['x', 'y', 'scale', 'rotation', 'opacity'].map((key) => [
            key,
            n(key),
          ]),
        ),
        keyframes: keyframes.map((fn) => fn()),
        poseCues: cues.map((fn) => fn()),
        contact: v('contact')
          ? {
              targetLayerId: v('contact'),
              anchor: { x: n('contactX'), y: n('contactY') },
            }
          : undefined,
      }));
      if (!poseOptions.length)
        box.append(note('포즈 전환에 사용할 채택 pose 이미지가 없습니다. identity-reference는 기본 인물 레이어에만 사용할 수 있습니다.'));
      box.append(
        button('움직임 시점 추가', () => {
          layers = read();
          layers[index].keyframes.push({
            frame: (layers[index].keyframes.at(-1)?.frame ?? 0) + 1,
            x: 0,
          });
          changed();
        }),
        button('포즈 전환 추가', () => {
          if (!poseOptions.length) return;
          layers = read();
          layers[index].poseCues.push({
            frame: (layers[index].poseCues.at(-1)?.frame ?? 0) + 1,
            slotId: poseOptions.some((option) => option.value === layers[index].slotId)
              ? layers[index].slotId : poseOptions[0].value,
          });
          changed();
        }, { disabled: !poseOptions.length }),
        button('마지막 움직임 제거', () => {
          layers = read();
          layers[index].keyframes.pop();
          changed();
        }),
        button('마지막 포즈 제거', () => {
          layers = read();
          layers[index].poseCues.pop();
          changed();
        }),
        button('레이어 제거', () => {
          layers = read();
          layers.splice(index, 1);
          changed();
        }),
      );
      root.append(box);
    });
    root.append(
      button('레이어 추가', () => {
        if (!imageOptions.length) return;
        layers = read();
        layers.push({
          id: uid('layer'),
          slotId: imageOptions[0]?.value ?? '',
          z: layers.length,
          anchor: { x: 0.5, y: 0.5 },
        });
        changed();
      }, { disabled: !imageOptions.length }),
    );
  }
  Object.defineProperty(root, 'value', {
    get: () => JSON.stringify(read()),
    set: (value) => {
      layers = JSON.parse(value);
      redraw();
    },
  });
  redraw();
  return root;
}
export function renderLayerEditor(c, scene, shot) {
  return card(
    '인물 레이어·포즈',
    note(
      '전체 레이어를 직접 구성합니다. 인물별 채택 이미지와 샷 상대 전환 프레임을 선택하세요. 회전은 라디안, 이동은 화면 크기 비율입니다. 표정·시선은 기록이며 새 그림을 만들지 않습니다.',
    ),
    form(
      c,
      `layers:${scene.id}:${shot.id}`,
      [
        {
          name: 'layers',
          label: '전체 레이어',
          value: JSON.stringify(shot.layers ?? []),
          render: (value) => layerControls(value, c, scene, shot),
        },
      ],
      async (p, rev) => {
        const next = structuredClone(scene),
          selected = next.shots.find((x) => x.id === shot.id),
          layers = JSON.parse(p.layers);
        if (layers.length) selected.layers = layers;
        else delete selected.layers;
        return c.send(
          command(c.snapshot, 'scene.put', 'scene', scene.id, next, rev),
        );
      },
      {
        revision: revision(c.snapshot, 'scene', scene.id),
        submit: '레이어·포즈 저장',
      },
    ),
  );
}
export function renderTimingEditor(c) {
  const s = c.snapshot,
    scene = chosenScene(c),
    productionId = c.selection.production || scene?.productionId;
  if (!scene || !productionId)
    return card('음악·무음 길이', note('제작판과 장면을 선택하세요.'));
  const timeline = s.timelines?.find(
      (x) => x.productionId === productionId || x.id === productionId,
    ),
    intent = timeline?.intent ?? { productionId },
    rev = revision(s, 'timeline', productionId);
  const save = (patch, expected = rev) =>
    c.send(
      command(
        s,
        'timeline.update',
        'timeline',
        productionId,
        { ...intent, productionId, ...patch },
        expected,
      ),
    );
  const root = card(
    '음악·무음 길이',
    note(
      `장면 전체 길이와 제작판 전체 길이는 다릅니다. 제작판 길이: ${
        timeline?.resolved?.durationMs ??
        ((timeline?.resolved?.durationFrames ?? 0) /
          (timeline?.resolved?.fps ?? 30)) *
          1000
      } ms. 무음 장면은 양수 길이를 지정하세요.`,
    ),
  );
  root.append(
    form(
      c,
      `duration:${productionId}:${scene.id}`,
      [
        number(
          'durationMs',
          '장면 전체 길이 (ms)',
          intent.sceneDurations?.find((x) => x.sceneId === scene.id)
            ?.durationMs ?? '',
          { min: 1, required: true },
        ),
      ],
      (p, r) =>
        save(
          {
            sceneDurations: [
              ...(intent.sceneDurations ?? []).filter(
                (x) => x.sceneId !== scene.id,
              ),
              { sceneId: scene.id, durationMs: Number(p.durationMs) },
            ],
          },
          r,
        ),
      { revision: rev, submit: '장면 길이 저장' },
    ),
  );
  const slots = s.slots
    .filter(
      (slot) =>
        slot.mediaKind === 'audio' &&
        slot.candidateId &&
        !slot.utteranceId &&
        slotInContext(slot, s, scene, c.selection.shot),
    )
    .filter((slot) =>
      ['music', 'sfx'].includes(
        slot.audioRole ??
          s.candidates.find((x) => x.id === slot.candidateId)?.reuseRole,
      ),
    );
  const fields = (track) => [
    {
      name: 'slotId',
      label: '채택한 독립 음원',
      value: track?.slotId ?? '',
      options: [
        ...new Map(
          [...slots, ...s.slots.filter((x) => x.id === track?.slotId)].map(
            (x) => [x.id, x],
          ),
        ).values(),
      ].map((slot) => ({
        value: slot.id,
        label: `${assetSlotLabel(s, slot)} · ${
          ['scene', 'shot'].includes(slot.scope.kind)
            ? '장면 상대 시간'
            : '제작판 전체 시간'
        }`,
      })),
    },
    {
      name: 'kind',
      label: '용도',
      value: track?.kind ?? 'music',
      options: [
        { value: 'music', label: '음악' },
        { value: 'sfx', label: '효과음' },
      ],
    },
    ...[
      ['startMs', '시작 (ms)', 0],
      ['trimStartMs', '원본 앞 자르기 (ms)', 0],
      ['trimEndMs', '원본 뒤 자르기 (ms, 비우면 0)', ''],
      ['gainDb', '음량 (dB)', 0],
      ['fadeInMs', '페이드 인 (ms)', 0],
      ['fadeOutMs', '페이드 아웃 (ms)', 0],
    ].map(([name, label, fallback]) =>
      number(name, label, track?.[name] ?? fallback, { step: 'any' }),
    ),
    {
      name: 'muted',
      label: '재생',
      value: track?.muted ? 'true' : 'false',
      options: [
        { value: 'false', label: '소리 있음' },
        { value: 'true', label: '음소거 (길이 유지)' },
      ],
    },
  ];
  const trackValue = (p, id) => ({
    id,
    kind: p.kind,
    slotId: p.slotId,
    startMs: Number(p.startMs),
    trimStartMs: Number(p.trimStartMs),
    ...(p.trimEndMs !== '' ? { trimEndMs: Number(p.trimEndMs) } : {}),
    gainDb: Number(p.gainDb),
    fadeInMs: Number(p.fadeInMs),
    fadeOutMs: Number(p.fadeOutMs),
    muted: p.muted === 'true',
  });
  for (const track of intent.tracks ?? [])
    root.append(
      form(
        c,
        `track:${productionId}:${track.id}`,
        fields(track),
        (p, r) =>
          save(
            {
              tracks: intent.tracks.map((x) =>
                x.id === track.id ? trackValue(p, track.id) : x,
              ),
            },
            r,
          ),
        { revision: rev, submit: '독립 음원 저장' },
      ),
      button(`음원 제거 · ${track.id}`, () =>
        c.run(async () => {
          await save({
            tracks: intent.tracks.filter((x) => x.id !== track.id),
          });
          await c.refresh(true);
        }),
      ),
    );
  root.append(
    form(
      c,
      `new-track:${productionId}`,
      fields(),
      (p, r) =>
        save(
          { tracks: [...(intent.tracks ?? []), trackValue(p, uid('track'))] },
          r,
        ),
      { revision: rev, submit: '독립 음원 추가', disabled: !slots.length },
    ),
    note(
      '음악·효과음은 Library에서 용도를 지정해 보존하고 별도로 채택하거나 자료 작업실에서 가져옵니다.',
    ),
  );
  return root;
}
