/**
 * 다국어 Phase 1 — 언어 계약의 생애 주기와 정본 저장.
 *
 * 확인하는 것: 실제 파일 왕복, 구작 키 부재의 보존, 형식 충돌에서의 무변경,
 * 생성 기록과의 대조, foundation 전후의 프로필 언어 규칙, v3 분량 계약.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { MarkdownStateStore } from '../src/store/markdown-store.js';
import { runInit } from '../src/tools/init.js';
import { runCreate, runRewriteTool } from '../src/tools/generate.js';
import { runStoryProfile, runStoryProfileDecide, runStoryProfileStatus } from '../src/tools/story-profile.js';
import { runConfigureStatus } from '../src/tools/configure.js';
import { readProfileLength, readStoredLanguage, resolveWorkLanguage } from '../src/core/work-language.js';

const WORK = 'w';

async function newStore(tag = 'lang') {
  return new MarkdownStateStore(await mkdtemp(join(tmpdir(), `vibelore-${tag}-`)));
}

const settingPath = (store) => join(store.rootDir, 'world', 'setting.md');
const characterPath = (store, id) => join(store.rootDir, 'characters', `${id}.md`);

function character(overrides = {}) {
  return {
    id: 'lead',
    canonicalName: 'Ann',
    aliases: [],
    registeredAtChapter: 1,
    contradiction: 'wants out, stays in',
    description: 'a quiet clerk',
    intrinsic: { role: '주인공', coreAppearance: [], addressing: { acceptedPronouns: [], acceptedGenderedTerms: [], forbiddenGenderedTerms: [] } },
    dramaticModel: { valueOrder: ['survival'] },
    speechProfile: { defaultRegister: 'plain' },
    ...overrides,
  };
}

async function expectCode(fn, code) {
  const err = await fn().then(() => null, (e) => e);
  assert.ok(err, `expected ${code} but the call succeeded`);
  assert.equal(err.code ?? err.message, code, `expected ${code}, got ${err.code ?? err.message}`);
  return err;
}

/** story-profile 응답만 흉내내는 최소 provider. */
function profileProvider(payload) {
  return {
    pending: [],
    async complete() { return { text: JSON.stringify(payload) }; },
  };
}

const BASE_PROFILE = {
  genreLabel: '조용한 사무 드라마',
  engineGenre: 'other',
  format: { pov: '3인칭제한', serialization: '웹소설 연재' },
  narrativeContract: { depthMode: 'commercial-dramatic' },
  promptGuidance: {},
  designReview: { settledDecisions: ['첫 결정'], openQuestions: [] },
};

describe('다국어 정본 저장 왕복', () => {
  const cases = [
    { language: 'ko', version: 1, name: '윤재', text: '조용한 사무직으로 산다.' },
    { language: 'en', version: 2, name: 'Ann', text: 'She keeps the ledger.' },
    { language: 'ja', version: 2, name: '灯里', text: '彼女は帳簿を守る。' },
    { language: 'zh-Hant', version: 2, name: '陳嵐', text: '她守著帳簿。' },
    { language: 'ar', version: 2, name: 'ليلى', text: 'هي تحفظ الدفتر.' },
  ];

  for (const { language, version, name, text } of cases) {
    it(`${language} 신작을 저장하고 손실 없이 다시 읽는다`, async () => {
      const store = await newStore(language.toLowerCase());
      const init = await runInit({ store, workId: WORK, genre: 'other', language, worldFacts: [text] });
      assert.equal(init.language, language);
      assert.equal(init.canonicalFormatVersion, version);

      const created = await store.loadFoundation(WORK);
      assert.equal(created.language, language);
      assert.equal(created.canonicalFormatVersion, version);
      await store.saveFoundation({
        ...created,
        characters: [character({ canonicalName: name, contradiction: text, description: text })],
      });

      const settingText = await readFile(settingPath(store), 'utf8');
      assert.match(settingText, new RegExp(`^language: ${language}$`, 'm'));
      assert.match(settingText, new RegExp(`^canonicalFormatVersion: ${version}$`, 'm'));
      assert.match(settingText, version === 2 ? /## World facts/ : /## 세계 사실/);

      const charText = await readFile(characterPath(store, 'lead'), 'utf8');
      assert.match(charText, new RegExp(`^language: ${language}$`, 'm'));
      assert.match(charText, version === 2 ? /## Contradiction/ : /## 모순/);
      assert.match(charText, version === 2 ? /## Speech profile/ : /## 말투 프로필/);
      assert.ok(charText.includes(name));

      const back = await store.loadFoundation(WORK);
      assert.equal(back.worldFacts[0].statement, text);
      assert.equal(back.characters[0].canonicalName, name);
      assert.equal(back.characters[0].contradiction, text);
      assert.equal(back.characters[0].description, text);
      assert.deepEqual(back.characters[0].dramaticModel, { valueOrder: ['survival'] });
      assert.deepEqual(back.characters[0].speechProfile, { defaultRegister: 'plain' });
    });
  }

  it('버전 2 는 내용이 비어도 소유 표제를 생성한다', async () => {
    const store = await newStore('empty-v2');
    await runInit({ store, workId: WORK, genre: 'other', language: 'ja' });
    const foundation = await store.loadFoundation(WORK);
    await store.saveFoundation({
      ...foundation,
      characters: [character({ contradiction: '', description: '', dramaticModel: undefined, speechProfile: undefined })],
    });
    const charText = await readFile(characterPath(store, 'lead'), 'utf8');
    for (const heading of ['## Contradiction', '## Description', '## Dramatic model', '## Speech profile']) {
      assert.ok(charText.includes(heading), `${heading} 가 없다`);
    }
  });

  it('사용자 섹션과 알 수 없는 frontmatter 는 v2 왕복에서도 보존된다', async () => {
    const store = await newStore('foreign-v2');
    await runInit({ store, workId: WORK, genre: 'other', language: 'en' });
    const foundation = await store.loadFoundation(WORK);
    await store.saveFoundation({ ...foundation, characters: [character()] });
    const path = characterPath(store, 'lead');
    const original = await readFile(path, 'utf8');
    await writeFile(path, original.replace('---\n\n', '---\n\n## Writer notes\nkeep this line.\n\n').replace('id: lead', 'id: lead\nmood: dry'), 'utf8');

    const reloaded = await store.loadFoundation(WORK);
    await store.saveFoundation(reloaded);
    const after = await readFile(path, 'utf8');
    assert.match(after, /## Writer notes\nkeep this line\./);
    assert.match(after, /^mood: dry$/m);
  });
});

describe('구작의 키 부재 보존', () => {
  it('언어 키 없는 작품은 저장을 반복해도 키가 생기지 않는다', async () => {
    const store = await newStore('legacy');
    await store.saveFoundation({
      workId: WORK, genre: 'other', worldFacts: [{ id: 'w1', statement: '탑은 닫혀 있다.' }],
      characters: [character({ canonicalName: '윤재' })],
    });
    const settingText = await readFile(settingPath(store), 'utf8');
    assert.doesNotMatch(settingText, /^language:/m);
    assert.doesNotMatch(settingText, /^canonicalFormatVersion:/m);

    const loaded = await store.loadFoundation(WORK);
    assert.equal(Object.hasOwn(loaded, 'language'), false);
    assert.equal(Object.hasOwn(loaded, 'canonicalFormatVersion'), false);

    // 실행 해석만 암묵적 ko 이고, 저장된 문서에는 여전히 키가 없다.
    const resolved = await resolveWorkLanguage({ store, workId: WORK });
    assert.equal(resolved.language, 'ko');
    assert.equal(resolved.implicitLegacy, true);
    assert.equal(resolved.canonicalFormatVersion, 1);

    await store.saveFoundation(loaded);
    assert.equal(await readFile(settingPath(store), 'utf8'), settingText);
    assert.doesNotMatch(await readFile(characterPath(store, 'lead'), 'utf8'), /^language:/m);
  });

  it('구작에 다른 언어를 명시하면 WORK_LANGUAGE_IMMUTABLE 로 거부한다', async () => {
    const store = await newStore('legacy-immutable');
    await store.saveFoundation({ workId: WORK, genre: 'other', worldFacts: [], characters: [] });
    await expectCode(() => resolveWorkLanguage({ store, workId: WORK, requested: 'ja' }), 'WORK_LANGUAGE_IMMUTABLE');
    await expectCode(() => runInit({ store, workId: WORK, genre: 'other', language: 'ja' }), 'WORK_LANGUAGE_IMMUTABLE');
  });

  it('조회는 문서를 다시 쓰지 않고 실행 언어와 분량만 보여 준다', async () => {
    const store = await newStore('status');
    await store.saveFoundation({ workId: WORK, genre: 'other', worldFacts: [], characters: [] });
    await store.saveStoryProfile(WORK, {
      workId: WORK, profileSchemaVersion: 2, status: 'active', revision: 1,
      format: { pov: '3인칭제한', chapterChars: 4200, serialization: '웹소설 연재' },
      promptGuidance: { draft: [], avoid: [] }, tracking: { engineBacked: [], semantic: [] },
    });
    const before = await readFile(settingPath(store), 'utf8');
    const profileBefore = await readFile(store.sidecar('story-profile.json'), 'utf8');

    const configured = await runConfigureStatus({ store, workId: WORK });
    assert.equal(configured.language.tag, 'ko');
    assert.equal(configured.language.implicit, true);
    // 구형 chapterChars 는 읽기 경계에서만 legacyCodeUnits 로 해석한다.
    assert.deepEqual(
      { unit: configured.length.unit, target: configured.length.target },
      { unit: 'legacyCodeUnits', target: 4200 },
    );

    const status = await runStoryProfileStatus({ store, workId: WORK });
    assert.equal(status.length.target, 4200);
    assert.equal(status.profile.format.chapterChars, 4200);

    assert.equal(await readFile(settingPath(store), 'utf8'), before);
    assert.equal(await readFile(store.sidecar('story-profile.json'), 'utf8'), profileBefore);
  });
});

describe('정본 형식 충돌', () => {
  async function koWorkWithCharacter(tag) {
    const store = await newStore(tag);
    await store.saveFoundation({
      workId: WORK, genre: 'other', worldFacts: [], characters: [character({ canonicalName: '윤재' })],
    });
    return store;
  }

  it('같은 의미의 표제가 두 언어로 있으면 CANONICAL_SECTION_CONFLICT 로 멈춘다', async () => {
    const store = await koWorkWithCharacter('conflict');
    const path = characterPath(store, 'lead');
    const original = await readFile(path, 'utf8');
    await writeFile(path, `${original}\n## Contradiction\ntranslated by hand\n`, 'utf8');
    const before = await readFile(path, 'utf8');

    await expectCode(() => store.loadFoundation(WORK), 'CANONICAL_SECTION_CONFLICT');
    assert.equal(await readFile(path, 'utf8'), before);
  });

  it('예상 표제가 사라지고 반대 언어 표제만 있으면 CANONICAL_FORMAT_MISMATCH 다', async () => {
    const store = await koWorkWithCharacter('mismatch');
    const path = characterPath(store, 'lead');
    const original = await readFile(path, 'utf8');
    await writeFile(path, original.replace('## 모순', '## Contradiction'), 'utf8');
    const before = await readFile(path, 'utf8');

    await expectCode(() => store.loadFoundation(WORK), 'CANONICAL_FORMAT_MISMATCH');
    assert.equal(await readFile(path, 'utf8'), before);
  });

  it('뒤쪽 인물 문서의 충돌 때문에 앞 문서만 바뀌지 않는다', async () => {
    const store = await newStore('atomic');
    await store.saveFoundation({
      workId: WORK, genre: 'other', worldFacts: [],
      characters: [character({ id: 'a', canonicalName: '가' }), character({ id: 'b', canonicalName: '나' })],
    });
    const pathB = characterPath(store, 'b');
    await writeFile(pathB, `${await readFile(pathB, 'utf8')}\n## Description\nhand translated\n`, 'utf8');
    const settingBefore = await readFile(settingPath(store), 'utf8');
    const aBefore = await readFile(characterPath(store, 'a'), 'utf8');

    await expectCode(() => store.saveFoundation({
      workId: WORK, genre: 'other', worldFacts: [{ id: 'w1', statement: '새 사실' }],
      characters: [character({ id: 'a', canonicalName: '가', description: '바뀐 설명' }), character({ id: 'b', canonicalName: '나' })],
    }), 'CANONICAL_SECTION_CONFLICT');

    assert.equal(await readFile(settingPath(store), 'utf8'), settingBefore);
    assert.equal(await readFile(characterPath(store, 'a'), 'utf8'), aBefore);
  });
});

describe('수락된 생성 기록', () => {
  it('형식 버전 키를 지워도 레거시로 강등되지 않는다', async () => {
    const store = await newStore('version-drop');
    await runInit({ store, workId: WORK, genre: 'other', language: 'ja', worldFacts: ['塔は閉じている。'] });
    const original = await readFile(settingPath(store), 'utf8');
    await writeFile(settingPath(store), original.replace(/^canonicalFormatVersion: 2\n/m, ''), 'utf8');

    const err = await expectCode(() => store.loadFoundation(WORK), 'CANONICAL_FORMAT_CONTRACT_MISMATCH');
    assert.equal(err.details.reason, 'version_key_removed');
  });

  it('생성 언어를 손으로 바꾸면 WORK_LANGUAGE_IMMUTABLE 이다', async () => {
    const store = await newStore('language-drift');
    await runInit({ store, workId: WORK, genre: 'other', language: 'ja' });
    const original = await readFile(settingPath(store), 'utf8');
    await writeFile(settingPath(store), original.replace('language: ja', 'language: en'), 'utf8');

    const err = await expectCode(() => store.loadFoundation(WORK), 'WORK_LANGUAGE_IMMUTABLE');
    assert.equal(err.details.expected, 'ja');
  });

  it('생성 기록과 다른 foundation 메타데이터는 쓰기 전에 거부한다', async () => {
    const store = await newStore('record-conflict');
    await store.saveAcceptedCreation(WORK, {
      schemaVersion: 1, workId: WORK, language: 'ja', canonicalFormatVersion: 2,
      length: { unit: 'graphemes', target: 3000 },
    });
    await expectCode(() => store.saveFoundation({
      workId: WORK, genre: 'other', language: 'en', canonicalFormatVersion: 1, worldFacts: [], characters: [],
    }), 'WORK_LANGUAGE_IMMUTABLE');
    await expectCode(() => store.saveFoundation({
      workId: WORK, genre: 'other', language: 'ja', canonicalFormatVersion: 1, worldFacts: [], characters: [],
    }), 'CANONICAL_FORMAT_CONTRACT_MISMATCH');
    assert.equal(await store.loadFoundation(WORK), null);
  });

  it('생성 기록은 다른 계약으로 덮어쓸 수 없다', async () => {
    const store = await newStore('record-immutable');
    const record = {
      schemaVersion: 1, workId: WORK, language: 'ja', canonicalFormatVersion: 2,
      length: { unit: 'graphemes', target: 3000 },
    };
    await store.saveAcceptedCreation(WORK, record);
    await store.saveAcceptedCreation(WORK, { ...record, acceptedAt: 'later' });
    await expectCode(
      () => store.saveAcceptedCreation(WORK, { ...record, language: 'en' }),
      'CREATION_RECORD_IMMUTABLE',
    );
  });

  it('언어 키가 있는데 값이 비었으면 구작이 아니라 손상된 계약이다', async () => {
    for (const broken of [null, '']) {
      const store = await newStore('broken-language');
      await store.saveStoryProfile(WORK, {
        workId: WORK, profileSchemaVersion: 3, status: 'active', revision: 1, language: broken,
        format: { pov: 'third', length: { unit: 'graphemes', target: 3000 } },
      });
      // 키가 존재하는 이상 암묵적 ko 구작으로 재분류하지 않는다.
      await expectCode(() => resolveWorkLanguage({ store, workId: WORK }), 'INVALID_LANGUAGE_TAG');
      await expectCode(() => runInit({ store, workId: WORK, genre: 'other' }), 'INVALID_LANGUAGE_TAG');
      await expectCode(() => runStoryProfileStatus({ store, workId: WORK }), 'INVALID_LANGUAGE_TAG');
    }
    // JSON 저장은 `undefined` 키를 지우므로, 키가 남아 있는 메모리 상의 계약으로
    // 확인한다. hasKey 는 값의 유효성과 무관하게 키의 존재만 본다.
    const keyedUndefined = { language: undefined, format: { length: { unit: 'graphemes', target: 3000 } } };
    assert.deepEqual(readStoredLanguage(keyedUndefined), { language: null, hasKey: true });
    const store = await newStore('broken-language-memory');
    await expectCode(
      () => resolveWorkLanguage({ store, workId: WORK, profile: keyedUndefined }),
      'INVALID_LANGUAGE_TAG',
    );
  });

  it('생성 뒤 프로필 언어를 손으로 바꿔도 실행 원천이 되지 않는다', async () => {
    const store = await newStore('profile-drift');
    await runInit({ store, workId: WORK, genre: 'other', language: 'ja' });
    await store.saveStoryProfile(WORK, {
      workId: WORK, profileSchemaVersion: 3, status: 'active', revision: 1, language: 'en',
      format: { pov: '3인칭제한', length: { unit: 'graphemes', target: 3000 } },
    });
    await expectCode(() => resolveWorkLanguage({ store, workId: WORK }), 'WORK_LANGUAGE_IMMUTABLE');
  });
});

describe('foundation 전후의 프로필 언어', () => {
  it('신규 비ko 프로필은 v3 분량과 natural 대사 정책을 저장한다', async () => {
    const store = await newStore('profile-ja');
    const result = await runStoryProfile({
      store, workId: WORK, brief: 'a quiet office drama', language: 'ja',
      providers: profileProvider(BASE_PROFILE),
    });
    assert.equal(result.profile.profileSchemaVersion, 3);
    assert.equal(result.profile.language, 'ja');
    assert.deepEqual(result.profile.format.length, { unit: 'graphemes', target: 3000 });
    assert.equal(result.profile.format.dialogueBreakMode, 'natural');
    assert.equal(Object.hasOwn(result.profile.format, 'chapterChars'), false);
    const raw = await readFile(store.sidecar('story-profile.json'), 'utf8');
    assert.doesNotMatch(raw, /chapterChars/);
  });

  it('신규 ko 프로필도 length 만 저장하고 strict 를 유지한다', async () => {
    const store = await newStore('profile-ko');
    const result = await runStoryProfile({
      store, workId: WORK, brief: '조용한 사무 드라마', providers: profileProvider(BASE_PROFILE),
    });
    assert.equal(result.profile.language, 'ko');
    assert.deepEqual(result.profile.format.length, { unit: 'legacyCodeUnits', target: 3000 });
    assert.equal(result.profile.format.dialogueBreakMode, 'strict');
    assert.equal(Object.hasOwn(result.profile.format, 'chapterChars'), false);
  });

  it('명시한 words 목표는 clamp 하지 않는다', async () => {
    const store = await newStore('profile-words');
    const result = await runStoryProfile({
      store, workId: WORK, brief: 'a serialized english novel', language: 'en',
      length: { unit: 'words', target: 45000 }, providers: profileProvider(BASE_PROFILE),
    });
    assert.deepEqual(result.profile.format.length, { unit: 'words', target: 45000 });
  });

  it('모델이 구형 chapterChars 로 답해도 length 로만 저장한다', async () => {
    const store = await newStore('profile-legacy-model');
    const result = await runStoryProfile({
      store, workId: WORK, brief: '조용한 사무 드라마',
      providers: profileProvider({ ...BASE_PROFILE, format: { ...BASE_PROFILE.format, chapterChars: 3200 } }),
    });
    assert.deepEqual(result.profile.format.length, { unit: 'legacyCodeUnits', target: 3200 });
    assert.equal(Object.hasOwn(result.profile.format, 'chapterChars'), false);
  });

  it('foundation 이전의 언어 변경은 승인을 계승하지 않는 새 revision 이다', async () => {
    const store = await newStore('profile-change');
    const first = await runStoryProfile({
      store, workId: WORK, brief: '조용한 사무 드라마', providers: profileProvider(BASE_PROFILE),
    });
    assert.equal(first.profile.language, 'ko');
    const approved = await runStoryProfileDecide({ store, workId: WORK, action: 'approve' });
    assert.equal(approved.profile.status, 'active');

    const stored = await store.loadStoryProfile(WORK);
    assert.ok(stored.designReview.settledDecisions.some((item) => item.includes('읽기 난도')));

    const second = await runStoryProfile({
      store, workId: WORK, brief: 'a quiet office drama', language: 'ja',
      providers: profileProvider({
        ...BASE_PROFILE,
        designReview: { settledDecisions: ['일본어판 결정'], openQuestions: [] },
      }),
    });
    assert.deepEqual(second.languageChanged, { from: 'ko', to: 'ja' });
    assert.equal(second.profile.language, 'ja');
    assert.equal(second.profile.revision, 2);
    // 이전 언어의 승인을 물려받지 않는다.
    assert.equal(second.profile.status, 'pending');
    assert.equal(second.profile.readabilityContract.confirmedByUser, false);
    assert.deepEqual(second.profile.format.length, { unit: 'graphemes', target: 3000 });
    // 이전 언어에서 확정된 결정과 질문 이력도 계승하지 않는다.
    assert.deepEqual(second.profile.designReview.settledDecisions, ['일본어판 결정']);
    assert.deepEqual(second.profile.designReview.askedQuestionIds, ['reading-experience-contract']);
    assert.equal(second.profile.supersedesRevision, 1);
  });

  it('승인되지 않은 revision 으로는 작품을 만들지 않는다', async () => {
    const store = await newStore('profile-pending');
    await runStoryProfile({
      store, workId: WORK, brief: 'a quiet office drama', language: 'ja',
      providers: profileProvider(BASE_PROFILE),
    });
    await expectCode(() => runInit({ store, workId: WORK, genre: 'other' }), 'PROFILE_REVISION_NOT_APPROVED');
    await expectCode(
      () => runCreate({ store, workId: WORK, title: 't', brief: 'b', genre: 'other', providers: profileProvider({}) }),
      'StoryProfile이 승인되지 않았습니다. lore_profile_decide로 승인하거나 다시 생성하세요.',
    );
  });

  it('승인된 프로필 언어와 다른 생성 인자는 생성 전에 거부한다', async () => {
    const store = await newStore('profile-create-conflict');
    await runStoryProfile({
      store, workId: WORK, brief: 'a quiet office drama', language: 'ja', mode: 'auto',
      providers: profileProvider(BASE_PROFILE),
    });
    await expectCode(
      () => runInit({ store, workId: WORK, genre: 'other', language: 'es' }),
      'LANGUAGE_CONTRACT_CONFLICT',
    );
    await expectCode(
      () => runCreate({ store, workId: WORK, title: 't', brief: 'b', language: 'es', providers: profileProvider({}) }),
      'LANGUAGE_CONTRACT_CONFLICT',
    );
    // 지정하지 않으면 저장된 프로필 언어를 따른다. schema/dispatch 기본값은 없다.
    const init = await runInit({ store, workId: WORK, genre: 'other' });
    assert.equal(init.language, 'ja');
    assert.equal(init.canonicalFormatVersion, 2);
  });

  it('foundation 이 생기면 프로필 재실행으로 언어를 바꾸지 못한다', async () => {
    const store = await newStore('profile-after-foundation');
    await runInit({ store, workId: WORK, genre: 'other', language: 'ja' });
    await expectCode(
      () => runStoryProfile({ store, workId: WORK, brief: 'x', language: 'en', providers: profileProvider(BASE_PROFILE) }),
      'WORK_LANGUAGE_IMMUTABLE',
    );
  });

  it('승인은 저장된 언어와 분량을 그대로 둔다', async () => {
    const store = await newStore('profile-approve');
    await runStoryProfile({
      store, workId: WORK, brief: 'a quiet office drama', language: 'ja',
      providers: profileProvider(BASE_PROFILE),
    });
    const approved = await runStoryProfileDecide({ store, workId: WORK, action: 'approve' });
    assert.equal(approved.profile.language, 'ja');
    assert.deepEqual(approved.profile.format.length, { unit: 'graphemes', target: 3000 });
  });
});

describe('분량 계약의 경계', () => {
  it('신규 length 와 구형 인자가 어긋나면 LENGTH_CONTRACT_CONFLICT 다', async () => {
    const store = await newStore('length-conflict');
    await expectCode(
      () => runCreate({
        store, workId: WORK, title: 't', brief: 'b', genre: 'other',
        length: { unit: 'legacyCodeUnits', target: 3000 }, chapterWordCount: 2500,
        providers: profileProvider({}),
      }),
      'LENGTH_CONTRACT_CONFLICT',
    );
  });

  it('단위와 목표가 모두 같으면 함께 지정해도 된다', async () => {
    const store = await newStore('length-agree');
    const resolved = await resolveWorkLanguage({
      store, workId: WORK,
      length: { unit: 'legacyCodeUnits', target: 3000 }, legacyLength: { chapterWordCount: 3000 },
    });
    assert.deepEqual(
      { unit: resolved.length.unit, target: resolved.length.target },
      { unit: 'legacyCodeUnits', target: 3000 },
    );
  });

  it('프로필에 length 와 chapterChars 가 함께 저장돼 있으면 진짜 충돌로 판정한다', async () => {
    const store = await newStore('length-stored-conflict');
    await store.saveStoryProfile(WORK, {
      workId: WORK, profileSchemaVersion: 3, status: 'active', revision: 1, language: 'en',
      format: { pov: 'third', length: { unit: 'words', target: 900 }, chapterChars: 3000 },
    });
    // 어댑터가 만든 중복이 아니라 둘 다 실제로 저장된 필드다.
    assert.throws(
      () => readProfileLength({ format: { length: { unit: 'words', target: 900 }, chapterChars: 3000 } }, { language: 'en' }),
      (err) => err.code === 'LENGTH_CONTRACT_CONFLICT',
    );
    await expectCode(() => resolveWorkLanguage({ store, workId: WORK }), 'LENGTH_CONTRACT_CONFLICT');
    await expectCode(() => runConfigureStatus({ store, workId: WORK }), 'LENGTH_CONTRACT_CONFLICT');
    // 단위와 목표가 모두 같으면 함께 저장돼 있어도 받아들인다.
    const agreeing = readProfileLength(
      { format: { length: { unit: 'legacyCodeUnits', target: 3000 }, chapterChars: 3000 } },
      { language: 'ko' },
    );
    assert.deepEqual({ unit: agreeing.unit, target: agreeing.target }, { unit: 'legacyCodeUnits', target: 3000 });
  });

  it('구형 프로필의 chapterChars 는 읽기 경계에서만 해석하고 가짜 중복을 만들지 않는다', () => {
    const legacy = { format: { pov: '3인칭제한', chapterChars: 2800 } };
    const read = readProfileLength(legacy, { language: 'ko' });
    assert.deepEqual({ unit: read.unit, target: read.target, source: read.source }, {
      unit: 'legacyCodeUnits', target: 2800, source: 'stored-legacy',
    });
    // 어댑터가 length 와 legacy 를 동시에 만들지 않으므로 충돌이 나지 않는다.
    assert.equal(readProfileLength(legacy, { language: 'ko', length: { unit: 'words', target: 900 } }).unit, 'words');
    assert.equal(legacy.format.chapterChars, 2800);
  });
});

describe('생성 이후 도구의 언어 전달', () => {
  it('rewrite 는 저장된 작품 언어를 엔진 요청까지 전달한다', async () => {
    const store = await newStore('rewrite-lang');
    await runInit({ store, workId: WORK, genre: 'other', language: 'ja' });
    const foundation = await store.loadFoundation(WORK);
    await store.saveFoundation({ ...foundation, characters: [character({ canonicalName: '灯里' })] });
    await store.saveArtifact({ workId: WORK, chapterNumber: 1, prose: '彼女は帳簿を閉じた。' });

    const requests = [];
    const providers = {
      pending: [],
      async complete(request) { requests.push(request); return { text: '書き直した本文。' }; },
    };
    await runRewriteTool({ store, workId: WORK, chapter: 1, intent: 'tighten', providers });
    const userMessage = requests.at(-1).messages.at(-1).content;
    // 검증된 작품 언어가 엔진 요청까지 간다는 뜻은 그대로다. 라벨이 한국어에서
    // 영어로 바뀐 것은 ja 작품이 다국어 계열 프롬프트로 간다는 뜻이며(계획: 비-ko
    // 최종 지시문은 영어), 언어 태그 자체는 여전히 저장된 ja 다.
    assert.match(userMessage, /## Target work language \(BCP 47\)\nja/);
    assert.doesNotMatch(userMessage, /## 언어\n/);

    await expectCode(
      () => runRewriteTool({ store, workId: WORK, chapter: 1, intent: 'tighten', language: 'en', providers }),
      'WORK_LANGUAGE_IMMUTABLE',
    );
  });
});

describe('MCP schema 와 dispatch', () => {
  it('language 와 length 는 schema/dispatch 에 기본값을 두지 않는다', async () => {
    const source = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
    const languageProperties = source.match(/language: \{ type: 'string'[^}]*\}/g) ?? [];
    assert.ok(languageProperties.length >= 5, 'language 인자가 노출되지 않았다');
    for (const property of languageProperties) assert.doesNotMatch(property, /default/);
    assert.match(source, /length: args\.length/);
    assert.match(source, /language: args\.language/);
    assert.doesNotMatch(source, /args\.language \?\?/);
  });
});
