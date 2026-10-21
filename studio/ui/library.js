import { command, revision } from './api.js';
import {
  el,
  card,
  button,
  note,
  form,
  details,
  uid,
  assetSlotLabel,
} from './dom.js';
import { goToWork } from './workflow.js';

// Bytes, exact command envelopes and receipts live in IndexedDB, not small localStorage.
// A saved item is sent unchanged after interruption; the destination's durable receipt
// decides replay. Successful items never run again during partial-success retry.
export function queueStorage() {
  let opened;
  const db = () =>
    (opened ??= new Promise((resolve, reject) => {
      const r = indexedDB.open('studio-preservation', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('queues');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }));
  const operation = async (mode, key, value) => {
    const database = await db();
    return new Promise((resolve, reject) => {
      const tx = database.transaction('queues', mode),
        store = tx.objectStore('queues');
      const r = mode === 'readonly' ? store.get(key) : store.put(value, key);
      tx.oncomplete = () => resolve(r.result);
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
  };
  return {
    load: (key) => operation('readonly', key),
    save: (key, value) => operation('readwrite', key, value),
  };
}
export const preservationKey = (api, projectId) =>
  `${api.bootstrap.destinationKey}:${projectId}`;
export class PreservationQueue {
  constructor(key, storage = queueStorage()) {
    this.key = key;
    this.storage = storage;
    this.items = [];
    this.running = false;
  }
  async load() {
    this.items = (await this.storage.load(this.key)) ?? [];
    return this;
  }
  async save() {
    await this.storage.save(this.key, structuredClone(this.items));
  }
  async add(envelope, label) {
    if (this.running) throw new Error('Preservation is running.');
    this.items.push({
      envelope: structuredClone(envelope),
      label,
      status: 'pending',
    });
    await this.save();
  }
  async remove(commandId) {
    if (this.running) return;
    this.items = this.items.filter((x) => x.envelope.commandId !== commandId);
    await this.save();
  }
  async resume(send, onProgress = () => {}) {
    if (this.running) return;
    this.running = true;
    try {
      for (const item of this.items) {
        if (item.receipt) continue;
        item.status = 'sending';
        delete item.error;
        await this.save();
        onProgress();
        try {
          item.receipt = await send(structuredClone(item.envelope));
          item.status = 'preserved';
        } catch (error) {
          item.status = 'unfinished';
          item.error = error.code ?? 'REQUEST_FAILED';
        }
        await this.save();
        onProgress();
      }
    } finally {
      this.running = false;
    }
  }
}
const refKey = (ref) =>
  JSON.stringify([
    ref.ownerId,
    ref.projectId,
    ref.recordKind,
    ref.recordId,
    ref.revision,
  ]);
const stateOptions = (s) =>
  [
    ...new Set([
      ...(s.story?.states ?? []).map((y) => y.id),
      ...s.scenes.flatMap((scene) =>
        (scene.presentations ?? [])
          .flatMap((p) => [p.appearanceStateRef, p.castingStateRef])
          .filter(Boolean),
      ),
    ]),
  ].map((value) => ({ value, label: value }));
const identityOptions = (s) =>
  [
    ...new Set(
      s.cast.map((r) => r.characterId ?? r.identity?.id).filter(Boolean),
    ),
  ].map((value) => ({
    value,
    label:
      s.cast.find((r) => r.characterId === value || r.identity?.id === value)
        ?.name ?? value,
  }));
function destinationSlot(s, p, mediaKind) {
  const existing = s.slots.find((x) => x.id === p.existingSlot);
  if (existing)
    return Object.fromEntries(
      [
        'id',
        'scope',
        'subject',
        'appearanceStateRef',
        'castingStateRef',
        'utteranceId',
        'audioRole',
      ]
        .filter((key) => existing[key] !== undefined)
        .map((key) => [key, existing[key]]),
    );
  return {
    id: p.slotId,
    scope: { kind: p.scopeKind, id: p.scopeId },
    subject: { kind: p.subjectKind, id: p.subjectId },
    appearanceStateRef: p.appearanceStateRef || null,
    ...(p.castingStateRef ? { castingStateRef: p.castingStateRef } : {}),
    ...(p.utteranceId ? { utteranceId: p.utteranceId } : {}),
    ...(mediaKind === 'audio' && ['music', 'sfx'].includes(p.role)
      ? { audioRole: p.role }
      : {}),
  };
}
export function renderReuseSelection(c, state) {
  const s = c.snapshot,
    { entry, exported } = state,
    record = exported.bundle.records.find(
      (r) => refKey(r.ref) === refKey(entry.ref),
    );
  const root = card(
    '정확한 원본 보존',
    details('원본 참조', entry.ref),
    note(
      '보존과 채택은 별도 작업입니다. 원문 보존은 제작판을 만들거나 원천 연결을 바꾸지 않습니다.',
    ),
  );
  if (!['text', 'image', 'audio'].includes(record.metadata.mediaKind))
    return (
      root.append(
        note(
          `${record.metadata.mediaKind}: 검색·보존용 내보내기는 가능하지만 Studio 소비·렌더링은 지원하지 않습니다.`,
        ),
        details('보존된 메타데이터', record),
      ),
      root
    );
  if (record.metadata.mediaKind === 'text') {
    root.append(
      form(
        c,
        `library-source:${refKey(entry.ref)}`,
        [
          {
            name: 'title',
            label: '원문 제목',
            value: entry.title,
            required: true,
          },
          {
            name: 'language',
            label: '작품 언어',
            value: s.project.language ?? 'ko',
            required: true,
          },
          { name: 'reason', label: '보존 목적', required: true },
        ],
        async (p) => {
          const id = uid('source');
          await state.queue.add(
            command(s, 'source.importBundle', 'sourcePackage', id, {
              ...exported,
              sourcePackageId: id,
              title: p.title,
              language: p.language,
              actor: 'creator',
              reason: p.reason,
            }),
            entry.title,
          );
          c.render();
        },
        { submit: '원문 보존 대기열에 추가' },
      ),
    );
    return root;
  }
  const subjects = record.metadata.subjects ?? [],
    states = [
      ...new Map(
        [
          ...subjects.flatMap((x) => x.stateRefs ?? []),
          ...(record.metadata.speakerStateRefs ?? []),
        ].map((x) => [refKey(x), x]),
      ).values(),
    ];
  const fields = [
    { name: 'purpose', label: '이번 사용 목적', required: true },
    {
      name: 'role',
      label: '사용 역할',
      options: (record.metadata.roles ?? []).map((value) => ({
        value,
        label: value,
      })),
    },
    {
      name: 'existingSlot',
      label: '기존 목적지 슬롯',
      options: [
        { value: '', label: '새 슬롯 (아래에서 범위·대상 지정)' },
        ...s.slots
          .filter((x) => x.mediaKind === record.metadata.mediaKind)
          .map((x) => ({ value: x.id, label: assetSlotLabel(s, x) })),
      ],
    },
    { name: 'slotId', label: '새 슬롯 이름', value: uid('reuse-slot') },
    {
      name: 'scopeKind',
      label: '새 슬롯 범위',
      options: ['project', 'production', 'scene', 'shot'].map((value) => ({
        value,
        label: value,
      })),
    },
    {
      name: 'scopeId',
      label: '범위 대상',
      value: s.project.id,
      options: [
        { value: s.project.id, label: `작품 · ${s.project.title}` },
        ...s.productions.map((x) => ({
          value: x.id,
          label: `제작판 · ${x.title}`,
        })),
        ...s.scenes.flatMap((x) => [
          { value: x.id, label: `장면 · ${x.title ?? x.id}` },
          ...x.shots.map((sh) => ({
            value: sh.id,
            label: `샷 · ${sh.title ?? sh.id}`,
          })),
        ]),
      ],
    },
    {
      name: 'subjectKind',
      label: '새 슬롯 대상 종류',
      options: ['environment', 'identity', 'role'].map((value) => ({
        value,
        label: value,
      })),
    },
    {
      name: 'subjectId',
      label: '대상 인물·배역 또는 공간 이름',
      value: 'environment',
      options: [{value:'environment',label:'배경 / 공간'},...identityOptions(s),...s.cast.map(role=>({value:role.id,label:`배역 · ${role.name}`}))],
    },
    {
      name: 'appearanceStateRef',
      label: '대상 외형 상태',
      options: [{ value: '', label: '없음' }, ...stateOptions(s)],
    },
    {
      name: 'castingStateRef',
      label: '대상 목소리 상태',
      options: [{ value: '', label: '없음' }, ...stateOptions(s)],
    },
    {
      name: 'utteranceId',
      label: '정확한 음성 테이크 발화',
      options: [
        { value: '', label: '발화 없음 (음악·효과음·참조)' },
        ...s.scenes.flatMap((x) =>
          x.utterances.map((u) => ({ value: u.id, label: u.text })),
        ),
      ],
    },
    ...subjects.map((subject, i) => ({
      name: `identity-${i}`,
      label: `인물 연결 · ${subject.identityId}`,
      options: [
        { value: '', label: '동일 인물 주장 없음' },
        ...identityOptions(s),
      ],
    })),
    ...states.map((ref, i) => ({
      name: `state-${i}`,
      label: `상태 연결 · ${ref.recordId} @ ${ref.revision}`,
      options: [{ value: '', label: '상태 연결 없음' }, ...stateOptions(s)],
    })),
  ];
  root.append(
    note(
      '동일 인물·상태로 사용할 때 실제 목적지 인물과 상태를 명시적으로 연결하세요. 참조 전용 역할의 역사 정보는 그대로 남습니다.',
    ),
    form(
      c,
      `reuse:${refKey(entry.ref)}`,
      fields,
      async (p) => {
        const slot = destinationSlot(s, p, record.metadata.mediaKind);
        const intent = {
          target: { kind: 'assetSlot', id: slot.id },
          purpose: p.purpose,
          identityMap: subjects.flatMap((source, i) =>
            p[`identity-${i}`]
              ? [{ source, destinationIdentityId: p[`identity-${i}`] }]
              : [],
          ),
          stateMap: states.flatMap((source, i) =>
            p[`state-${i}`]
              ? [{ source, destinationStateId: p[`state-${i}`] }]
              : [],
          ),
          selections: [{ source: entry.ref, slot, role: p.role }],
        };
        state.inspection = await c.api.inspectReuse({ ...exported, intent });
        state.intent = intent;
        state.inspectedRevision = revision(s, 'assetSlot', slot.id);
        c.render();
      },
      { submit: '목적·연결 검사' },
    ),
  );
  if (state.inspection) {
    root.append(
      note(`검사 결과 · ${state.inspection.disposition}`),
      details('사용 목적과 연결 결정', state.intent),
      details('검사 근거·지원 여부', state.inspection.findings),
      details('원본→정규화 바이트', state.inspection.materializations),
    );
    root.append(
      button(
        '검사한 자료 보존 대기열에 추가',
        () =>
          c.run(async () => {
            const envelope = command(
              s,
              'asset.importBundle',
              'assetSlot',
              state.intent.target.id,
              {
                ...exported,
                intent: state.intent,
                inspectionDigest: state.inspection.inspectionDigest,
                actor: 'creator',
                reason: state.intent.purpose,
              },
              state.inspectedRevision,
            );
            await state.queue.add(envelope, entry.title);
            state.inspection = null;
            c.render();
          }),
        { disabled: state.inspection.disposition !== 'compatible' },
      ),
    );
  }
  return root;
}
async function readDirectory(files) {
  const list = Array.from(files ?? []),
    manifest = list.find(
      (f) =>
        f.webkitRelativePath?.split('/').slice(1).join('/') === 'manifest.json',
    );
  if (!manifest)
    throw Object.assign(new Error(), { code: 'BUNDLE_DIRECTORY_REQUIRED' });
  if (manifest.size > 512 * 1024)
    throw Object.assign(new Error(), { code: 'BUNDLE_LIMIT_EXCEEDED' });
  const bundle = JSON.parse(await manifest.text()),
    bytes = {};
  let total = 0;
  for (const descriptor of bundle.files ?? []) {
    const file = list.find(
      (f) =>
        f.webkitRelativePath.split('/').slice(1).join('/') ===
        `files/${descriptor.sha256}`,
    );
    if (!file) throw Object.assign(new Error(), { code: 'BUNDLE_INCOMPLETE' });
    total += file.size;
    if (file.size > 20 * 1024 * 1024 || total > 24 * 1024 * 1024)
      throw Object.assign(new Error(), { code: 'BUNDLE_LIMIT_EXCEEDED' });
    bytes[descriptor.sha256] = Array.from(
      new Uint8Array(await file.arrayBuffer()),
    );
  }
  return { bundle, bytes };
}
export function renderLibrary(c) {
  const root = el('div', { class: 'library-view' });
  if (!c.api.bootstrap?.library?.available)
    return card(
      'Library 연결',
      note(
        c.api.bootstrap?.library?.setup ??
          'Studio를 --library <directory> 옵션으로 시작하세요. 소유자와 작품은 직접 연결합니다.',
      ),
    );
  const state = (c.libraryState ??= {
    filter: { type: 'find' },
    loaded: false,
    loading: false,
  });
  const reload = async () => {
    state.result = await c.api.libraryQuery(state.filter);
    state.loaded = true;
  };
  if (!state.loading && !state.loaded) {
    state.loading = true;
    c.run(async () => {
      try {
        state.queue ??= await new PreservationQueue(
          preservationKey(c.api, c.snapshot.project.id),
        ).load();
        await reload();
      } finally {
        state.loading = false;
      }
      c.render();
    });
  }
  root.append(
    card(
      '명시적 소유자 연결',
      note(
        '기존 Studio 또는 vibelore 폴더와 허용 작품 ID를 직접 지정합니다. 폴더 자동 검색은 하지 않습니다.',
      ),
      form(
        c,
        'library-register',
        [
          {
            name: 'adapterKind',
            label: '원천 종류',
            options: [
              { value: 'studio', label: 'Studio' },
              { value: 'vibelore', label: 'vibelore' },
            ],
          },
          {
            name: 'directory',
            label: '기존 원천 폴더 (비공개)',
            required: true,
            serializeDraft: () => '',
          },
          {
            name: 'projects',
            label: '허용 작품 ID (쉼표 구분)',
            required: true,
          },
        ],
        async (p) => {
          await c.api.libraryCommand({
            commandId: crypto.randomUUID(),
            expectedRegistryRevision: state.result.registryRevision,
            type: 'owner.register',
            payload: {
              adapterKind: p.adapterKind,
              locator: { directory: p.directory },
              allowedProjects: p.projects
                .split(',')
                .map((x) => x.trim())
                .filter(Boolean),
            },
          });
          await reload();
        },
        { submit: '소유자 연결', disabled: !state.loaded },
      ),
    ),
  );
  root.append(
    form(
      c,
      'library-find',
      [
        { name: 'text', label: '이름 검색' },
        {
          name: 'mediaKind',
          label: '매체',
          options: [
            { value: '', label: '전체' },
            ...['text', 'image', 'audio', 'video', 'structured'].map(
              (value) => ({ value, label: value }),
            ),
          ],
        },
        {
          name: 'ownerId',
          label: '소유자',
          options: [
            { value: '', label: '전체' },
            ...(state.result?.owners ?? []).map((o) => ({
              value: o.ownerId,
              label: `${o.adapterKind} · ${o.ownerId}`,
            })),
          ],
        },
        { name: 'projectId', label: '원천 작품 ID' },
        { name: 'role', label: '역할 필터' },
      ],
      async (p) => {
        state.filter = {
          type: 'find',
          ...Object.fromEntries(Object.entries(p).filter(([, v]) => v)),
        };
        await reload();
      },
      { submit: '자료 찾기' },
    ),
  );
  for (const owner of state.result?.owners ?? [])
    root.append(
      card(
        `${owner.adapterKind} · ${owner.ownerId}`,
        details('연결 범위·마지막 관찰', owner),
        button('관찰 새로고침', () =>
          c.run(async () => {
            const r = await c.api.libraryQuery({ type: 'find' });
            await c.api.libraryCommand({
              commandId: crypto.randomUUID(),
              expectedRegistryRevision: r.registryRevision,
              type: 'owner.refresh',
              payload: { ownerId: owner.ownerId },
            });
            await reload();
            c.render();
          }),
        ),
        button('연결 해제', () =>
          c.run(async () => {
            const r = await c.api.libraryQuery({ type: 'find' });
            await c.api.libraryCommand({
              commandId: crypto.randomUUID(),
              expectedRegistryRevision: r.registryRevision,
              type: 'owner.unregister',
              payload: { ownerId: owner.ownerId },
            });
            await reload();
            c.render();
          }),
        ),
      ),
    );
  root.append(
    card(
      '관찰된 자료',
      note(
        'offline: 원천 연결 불가 · missing: 마지막 정상 관찰에서 해당 정확한 판이 없음 · unverified: 현재 연결에서 미확인. 관찰 시각은 실시간 보장이 아닙니다.',
      ),
      ...(state.result?.entries ?? []).map((entry) =>
        button(
          `${entry.title} · ${entry.mediaKind} · ${entry.availability} · ${
            entry.observed?.at ?? '미관찰'
          }`,
          () =>
            c.run(async () => {
              state.entry = entry;
              state.exported = null;
              state.inspection = null;
              const [inspection, lineage, uses, cases] = await Promise.all([
                c.api.libraryQuery({ type: 'inspect', ref: entry.ref }),
                c.api.libraryQuery({ type: 'lineage', ref: entry.ref }),
                c.api.libraryQuery({ type: 'uses', ref: entry.ref }),
                c.api.libraryQuery({
                  type: 'cases',
                  ownerId: entry.ref.ownerId,
                  projectId: entry.ref.projectId,
                }),
              ]);
              Object.assign(state, {
                detail: { inspection, lineage, uses, cases },
              });
              c.render();
            }),
        ),
      ),
    ),
  );
  if (state.entry) {
    root.append(
      card(
        state.entry.title,
        details('정확한 판·가용성·관찰 시각·능력', state.entry),
        details('계보·사용·관찰 근거', state.detail),
        button('정확한 판 내보내기·검사 준비', () =>
          c.run(async () => {
            state.exported = await c.api.libraryExport({
              ownerId: state.entry.ref.ownerId,
              roots: [state.entry.ref],
              disclosure: {
                includedScope: 'Explicit selected Library record',
                omittedEvidence: [],
              },
            });
            state.inspection = null;
            c.render();
          }),
        ),
        button(
          '선택 번들 폴더에 저장',
          async () => {
            if (!globalThis.showDirectoryPicker) return;
            c.run(async () => {
              const directory = await showDirectoryPicker({
                  mode: 'readwrite',
                }),
                output = await c.api.libraryExport({
                  ownerId: state.entry.ref.ownerId,
                  roots: [state.entry.ref],
                  disclosure: {
                    includedScope: 'Explicit selected Library record',
                    omittedEvidence: [],
                  },
                });
              const write = async (dir, name, bytes) => {
                const file = await dir.getFileHandle(name, { create: true }),
                  stream = await file.createWritable();
                await stream.write(bytes);
                await stream.close();
              };
              await write(
                directory,
                'manifest.json',
                JSON.stringify(output.bundle, null, 2),
              );
              const folder = await directory.getDirectoryHandle('files', {
                create: true,
              });
              for (const [hash, bytes] of Object.entries(output.bytes))
                await write(folder, hash, Uint8Array.from(bytes));
            });
          },
          { disabled: !globalThis.showDirectoryPicker },
        ),
        !globalThis.showDirectoryPicker
          ? note(
              '폴더 저장은 File System Access를 지원하는 로컬 브라우저에서 사용할 수 있습니다. API는 동일한 manifest와 bytes를 반환합니다.',
            )
          : null,
      ),
    );
  }
  const directoryInput = el('input', {
    type: 'file',
    multiple: true,
    webkitdirectory: true,
    onchange: (event) =>
      c.run(async () => {
        const exported = await readDirectory(event.target.files);
        state.uploaded = exported;
        c.render();
      }),
  });
  root.append(
    card(
      '번들 폴더 불러오기',
      directoryInput,
      note(
        'manifest.json + files/<sha256>. 가져온 번들은 목적지 검사에서 실제 해시·한도·지원 형식을 검증합니다.',
      ),
    ),
  );
  if (state.uploaded) {
    root.append(
      card(
        '불러온 정확한 루트 선택',
        ...state.uploaded.bundle.roots.map((ref) =>
          button(
            `${ref.recordKind} · ${ref.recordId} @ ${ref.revision}`,
            () => {
              const record = state.uploaded.bundle.records.find(
                (x) => refKey(x.ref) === refKey(ref),
              );
              state.exported = state.uploaded;
              state.entry = {
                ref,
                title: record.metadata.title ?? ref.recordId,
                mediaKind: record.metadata.mediaKind,
              };
              state.inspection = null;
              c.render();
            },
          ),
        ),
      ),
    );
  }
  if (state.exported && state.queue)
    root.append(renderReuseSelection(c, state));
  if (state.queue) {
    root.append(
      card(
        '항목별 보존 진행',
        note(
          '완료 영수증은 유지하며 미완료만 같은 명령 ID로 재시도합니다. 변경된 목적지로 재검사가 필요하면 미완료 항목을 제거하고 다시 검사하세요.',
        ),
        button(
          '미완료 보존 실행·재개',
          () =>
            c.run(async () => {
              await state.queue.resume(
                (envelope) => c.api.command(envelope),
                () => c.render(),
              );
              await c.refresh(true);
            }),
          { disabled: state.queue.running },
        ),
        ...state.queue.items.map((item) =>
          card(
            `${item.label} · ${item.status}`,
            note(item.error ?? ''),
            details('고정 명령 ID·영수증', {
              commandId: item.envelope.commandId,
              receipt: item.receipt,
            }),
            item.receipt?.value?.candidate
              ? button('이 후보를 별도로 검토·채택', () =>
                  goToWork(c, 'assets', {
                    slot: item.envelope.aggregate.id,
                    candidate: item.receipt.value.candidate.id,
                    assetKind: item.receipt.value.candidate.mediaKind,
                  }),
                )
              : item.receipt
              ? button('원작·각색에서 연결 검토', () =>
                  goToWork(c, 'story', {}),
                )
              : null,
            button(
              '대기열 기록 제거',
              () =>
                c.run(async () => {
                  await state.queue.remove(item.envelope.commandId);
                  c.render();
                }),
              { disabled: state.queue.running },
            ),
          ),
        ),
      ),
    );
  }
  return root;
}
