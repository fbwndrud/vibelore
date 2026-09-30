#!/usr/bin/env node
/**
 * vibelore MCP server -- stdio, newline-delimited JSON-RPC, zero dependencies.
 *
 * Hand-rolled rather than built on the official SDK, for one reason that
 * matters here: this plugin has to be installable by a novelist on a laptop
 * with no build step and no npm install, in three different hosts. A server
 * that is one `node` invocation with nothing to fetch cannot break in the ways
 * a dependency tree can. The protocol surface it needs -- initialize,
 * tools/list, tools/call -- is small enough that this is a fair trade.
 *
 * See HOSTS.md for what was verified against which host and version. If the
 * protocol moves, that file is where the evidence lives.
 */
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { validateToolInput } from './core/tool-input.js';
import { withProjectLock } from './core/project-lock.js';

import { MarkdownStateStore } from './store/markdown-store.js';
import { createHostRelay, createPreflightRelay } from './provider/host-relay.js';
import { createLocalOpenAIProvider } from './provider/local-openai.js';
import { withJsonRepair } from './provider/json-repair.js';
import { runInit } from './tools/init.js';
import { buildContext } from './tools/context.js';
import { runCheck } from './tools/check.js';
import { runCommit, runStatus } from './tools/commit.js';
import { runCreate, runDraftTool, runReviseTool, runRewriteTool, runNextArc, runRefold } from './tools/generate.js';
import { runEraResearchTool } from './tools/era-research.js';
import { runArcPlan, runArcDecide, runArcStatus } from './tools/arc.js';
import { runStoryProfile, runStoryProfileDecide, runStoryProfileStatus } from './tools/story-profile.js';
import { runStorySpine, runStorySpineDecide, runStorySpineStatus } from './tools/story-spine.js';
import { runWriterSkill, runWriterSkillDecide, runWriterSkillStatus } from './tools/writer-skill.js';
import { runEpisodePlan, runEpisodeDecide, runEpisodeStatus } from './tools/episode-plan.js';
import { runWriteWorkflow, runWorkflowDecide, runWorkflowStatus, runWorkflowHistory, runWorkflowInspect } from './tools/workflow.js';
import { listSnapshots, rollbackToSnapshot, resumePendingRollback } from './tools/snapshots.js';
import { runStoredArcReview } from './tools/arc-review.js';
import { runConfigureStatus } from './tools/configure.js';
import { runSyncStatus } from './tools/sync.js';
import { runStyleAnchor } from './tools/style-anchor.js';
import { dropRun, loadRun, sweepRuns } from './runs.js';
import { runRelayedTool } from './relay-runner.js';
import { runWebtoonTool, readWebtoonWorkflow } from './tools/webtoon.js';
import { runWebtoonSceneTool } from './tools/webtoon-scene.js';
import { SCENE_PANEL_LIMITS, SCENE_AUTO_REVISIONS } from './core/webtoon-scene.js';

const SERVER_INFO = { name: 'vibelore', version: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version };
const FALLBACK_PROTOCOL = '2025-06-18';
const SUPPORTED_PROTOCOLS = new Set(['2024-11-05', '2025-03-26', FALLBACK_PROTOCOL]);

const projectArg = {
  project: { type: 'string', description: '작품 디렉터리의 절대 경로. 생략하면 서버 실행 디렉터리.' },
  workId: { type: 'string', minLength: 1, maxLength: 120, pattern: '^[A-Za-z0-9_-]+$', description: '작품 식별자 ([A-Za-z0-9_-]). 한 디렉터리에는 작품 하나만 둔다.' },
};

// MCP tool annotations. Every call also takes the project lock and may finish an
// interrupted rollback first; the hints describe what the tool itself does. The
// server never reaches the network except a local model the operator configures,
// so openWorldHint stays false.
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const writes = ({ destructive = false, idempotent = false } = {}) => ({ readOnlyHint: false, destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: false });

const languageArg = { type: 'string', description: '작품 언어 BCP 47 태그(예: ko, en-US, ja, zh-Hant). 생략하면 저장된 계약을 따른다.' };
const lengthArg = { type: 'object', description: '화당 분량 계약. unit 은 legacyCodeUnits|graphemes|words, target 은 양의 정수.', properties: { unit: { type: 'string', enum: ['legacyCodeUnits', 'graphemes', 'words'] }, target: { type: 'number' } }, required: ['unit', 'target'] };
const planModeArg = { type: 'string', enum: ['review', 'auto'], description: 'review(기본)=pending으로 저장하고 사용자 승인을 기다린다. auto=검증 통과 즉시 active로 저장한다. 사용자가 "알아서·묻지 말고"라고 한 경우만 auto.' };
const decideActionArg = (next) => ({ type: 'string', enum: ['approve', 'reject'], description: `approve=active로 전환한다(생성 때 받은 검증 영수증이 없거나 이후 정본이 바뀌었으면 status=clean_fail). reject=rejected로 표시하고 파일은 지우지 않는다. 거절 뒤에는 ${next}을 feedback과 함께 다시 호출한다.` });
const webtoonRevisionArg = { type: 'integer', description: '낙관적 동시성 확인용 현재 revision. 저장된 값과 다르면 STALE_WEBTOON_REVISION으로 거부한다. 생략 가능.' };

const TOOLS = [
  {
    name: 'lore_init',
    annotations: writes({ idempotent: true }),
    description:
      '작가가 직접 채울 빈 작품 기반(world/setting.md, 빈 chapters·summaries·characters 디렉터리, .vibelore/foundation.json)을 만들거나, world/setting.md가 이미 있는 디렉터리를 쓰기 없이 이어받는다. '
      + '모델이 세계·인물을 자동 설계하게 하려면 이 도구 대신 lore_profile → lore_profile_decide → lore_create를 쓴다. lore_create는 기반이 있으면 거부하므로 둘 중 하나만 쓴다. '
      + '새 작품은 언어 계약 검증 때문에 보통 status=needs_model을 한 번 돌려주며 lore_resume으로 답해야 저장된다. 재호출은 덮어쓰지 않고 adopted=true와 현재 상태를 돌려준다.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        genre: { type: 'string', description: '엔진 장르 id(예: mystery-thriller, romantasy, regression-hunter, cozy, other). 틀리면 사용 가능 목록과 함께 거부한다. 기존 작품을 이어받을 때는 무시된다.' },
        povMode: { type: 'string', description: '자유 텍스트 시점(예: 3인칭제한, 1인칭). omniscient·multi-pov는 단일 화자 검사를 생략하고 none은 시점 검사를 끈다. 생략하면 제한 3인칭.' },
        targetChapters: { type: 'number', description: '완결 목표 화수. 아크 위치 계산에 쓰인다. 생략하면 저장하지 않는다.' },
        worldFacts: { type: 'array', items: { type: 'string' }, description: '변하지 않는 세계 사실 5~10개. w1..wN id로 world/setting.md에 기록된다.' },
        language: languageArg,
      },
      required: ['workId', 'genre'],
    },
  },
  {
    name: 'lore_context',
    annotations: READ_ONLY,
    description:
      '다음 화를 쓰기 직전에 호출한다. 세계 사실, 고정된 인물 설정, 호칭 관계, 미해결 떡밥, 최근 화 요약을 하나의 컨텍스트 블록으로 조립해 돌려준다. 이걸 읽고 쓰면 설정이 어긋나지 않는다.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        chapter: { type: 'integer', minimum: 1, description: '이제 쓸 화 번호.' },
        scene: {
          type: 'object',
          description: '이 화에 등장시킬 엔티티 id 목록(선택).',
          properties: { entityIds: { type: 'array', items: { type: 'string' } } },
        },
      },
      required: ['workId', 'chapter'],
    },
  },
  {
    name: 'lore_check',
    annotations: writes(),
    description:
      '초고를 검증한다. 호칭 모순, 시점 이탈, 고정 설정 위반, 문체·운율, 대사 비율, 정보 반복, 민감 표현을 한 번에 훑고 무엇이 어디서 깨졌는지 돌려준다. 커밋 전에 반드시 통과시킨다. 의미 판정을 위해 모델 작업이 필요하면 status=needs_model 과 함께 질문을 돌려주니 lore_resume 로 답을 넘긴다.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        retryValidation: { type: 'boolean', description: '보존된 원고의 검증을 새 epoch에서 명시적으로 다시 시작한다.' },
        chapter: { type: 'integer', minimum: 1 },
        title: { type: 'string' },
        summary: { type: ['string', 'object'] },
        prose: { type: 'string', description: '검증할 본문 전체.' },
        castManifestRaw: { type: 'string', description: '집필 시 만든 캐스트 매니페스트(선택).' },
        deterministicOnly: { type: 'boolean', description: 'true 면 모델 작업 없이 결정론 검사만 수행.' },
      },
      required: ['workId', 'chapter', 'prose'],
    },
  },
  {
    name: 'lore_commit',
    annotations: writes({ destructive: true }),
    description:
      '검증을 통과한 화를 작품의 정식 상태로 반영한다. 본문을 chapters/ 에 쓰고, 델타를 접어 스토리 상태·호칭·떡밥·엔티티를 갱신한다. summary를 생략하면 다음 화가 기억할 회차 요약을 자동 생성한다.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        chapter: { type: 'integer', minimum: 1 },
        prose: { type: 'string' },
        title: { type: 'string' },
        summary: { type: 'string', description: '직접 지정할 2~4문장 요약(선택). 생략하면 본문에서 자동 생성한다.' },
        castManifestRaw: { type: 'string' },
        checkId: { type: 'string', description: '활성 통합 워크플로가 발급한 검사 영수증 id.' },
      },
      required: ['workId', 'chapter', 'prose'],
    },
  },
  {
    name: 'lore_status',
    annotations: READ_ONLY,
    description: '작품 전체 진행 요약을 읽기 전용으로 조회한다. 게시된 정본(Published HEAD) 기준 화수·다음 화 번호·등장인물·세계 사실 수·미해결 떡밥·아크 진행·StoryProfile 상태와, 손수정 여부를 뜻하는 workingTree(clean·modified 등)를 돌려준다. '
      + '작품이 없으면 오류 대신 initialized=false를 돌려준다. 진행 중인 한 화의 단계는 lore_workflow_status, 설정 누락 점검은 lore_configure, 개별 계획 내용은 lore_*_status로 본다. workingTree가 clean이 아니면 집필 전에 lore_sync를 호출한다.',
    inputSchema: { type: 'object', properties: { ...projectArg }, required: ['workId'] },
  },
  {
    name: 'lore_configure',
    annotations: writes({ idempotent: true }),
    description: '작품 설정을 조회하거나 바꾼다. 인자 없이 호출하면 읽기 전용으로 StoryProfile·StorySpine·WriterSkill을 하나의 NarrativeContract로 묶어 status(ready|incomplete), 누락 단계(missing), 언어·분량 계약, 검토·추적 설정을 돌려준다. '
      + 'disabledReviews·disabledDraftSections·tracking·customTracking·mergeRecords 중 하나라도 넘기면 .vibelore/review-policy.json에 저장한다. 목록과 tracking 객체는 통째로 교체되고(빈 배열=모두 켬), mergeRecords만 누적된다. 변경은 다음 커밋부터 적용되며 이미 쓴 화는 바뀌지 않는다. 모델 호출 없음.',
    inputSchema: { type: 'object', properties: { ...projectArg,
      disabledReviews: { type: 'array', items: { type: 'string', enum: ['story-profile-check', 'coherence-judge', 'editorial-quality', 'character-fidelity', 'reader-hook', 'pattern-ledger'] },
        description: '끌 검토 목록 전체(빈 배열이면 모두 켬). 꺼진 검토는 요청하지 않고 실패로 보지 않는다. 연속성 추출·검사는 끌 수 없다.' },
      disabledDraftSections: { type: 'array', items: { type: 'string', enum: ['older-memory', 'previous-tail', 'author-craft', 'style-anchor'] },
        description: '초고 요청에서 뺄 선택 섹션 목록 전체(빈 배열이면 모두 넣음): older-memory=오래된 관련 기억, previous-tail=직전 화 말미, author-craft=작법 묶음, style-anchor=문체 기준 예시. 계획·설정·현재 상태·최근 요약은 뺄 수 없다.' },
      tracking: { type: 'object', properties: { objects: { type: 'boolean' }, knowledge: { type: 'boolean' }, scheduled: { type: 'boolean' }, hooks: { type: 'boolean' } }, additionalProperties: false,
        description: '추적 기능 켜기/끄기. 기본은 모두 켜짐. objects=물건·장소·단서·능력, knowledge=누가 무엇을 아는가, scheduled=일어나기로 된 일(회귀 전생 사건·예언·예약), hooks=떡밥.' },
      customTracking: { type: 'array', items: { type: 'object', properties: {
        name: { type: 'string', description: '항목 이름. 같은 이름은 같은 id를 유지한다.' }, feature: { type: 'string', enum: ['objects', 'knowledge', 'scheduled'], description: '어느 추적 기능에 붙일지.' }, pinned: { type: 'boolean' },
        rules: { type: 'array', items: { type: 'object' } }, note: { type: 'string' } }, required: ['name', 'feature'] },
        description: '작가 정의 추적 항목 전체 목록(교체). pinned=매 화 입력에 항상 포함. rules: monotonic{field,direction:up|down,unless?}, frozenAfter{status}, speakerOnly{alias,by}; severity soft(기본)|hard. note=검토 모델에 보여줄 자연어 규칙(advisory).' },
      mergeRecords: { type: 'array', items: { type: 'object', properties: { from: { type: 'string', description: '흡수될 기록 id' }, into: { type: 'string', description: '남길 기록 id' } }, required: ['from', 'into'] },
        description: '같은 대상으로 확인된 기록 병합(from을 into에 흡수). 후보는 조회 결과의 mergeCandidates에 있다. 기존 병합에 누적되며 다음 커밋부터 반영.' },
    }, required: ['workId'] },
  },
  {
    name: 'lore_style_anchor',
    annotations: writes({ idempotent: true }),
    description: '사용자가 좋다고 승인한 정본 1~3화를 작품의 문체 기준으로 고정하거나 현재 기준을 조회한다. 자동으로 최신 화를 기준으로 삼지 않으므로 사용자가 특정 화를 좋다고 말했을 때만 approve한다. '
      + 'action=status(기본)는 읽기 전용이고 기준이 없으면 status=missing. approve는 .vibelore/style-anchor.json의 이전 기준을 새 기준으로 교체하고 {status:active, anchor(revision·발췌·기준 지문)}를 돌려준다. 모델 호출 없음. 초고 요청에서 기준 예시를 빼려면 lore_configure의 disabledDraftSections에 style-anchor를 넣는다.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        action: { type: 'string', enum: ['status', 'approve'], description: 'status(기본)=조회, approve=지정 화를 새 문체 기준으로 승인' },
        chapters: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'number' }, description: 'approve할 정본 화 번호 1~3개' },
        reason: { type: 'string', maxLength: 2000, description: '사용자가 이 원고를 선호한 이유. 작품 전체의 새 의무가 아닌 문체 참고로 전달한다.' },
      },
      required: ['workId'],
    },
  },
  {
    name: 'lore_sync',
    annotations: writes(),
    description: 'Published HEAD 이후 사람이 world/·characters/·chapters/에서 직접 고친 Markdown을 정본에 반영한다. lore_status나 lore_write가 working-tree drift(needs_sync)를 보고하면 집필 전에 이 도구를 쓴다. 공백만 바뀐 편집은 무시한다. '
      + '3단계 승인 흐름: inspect(기본)는 변경을 분류만 한다(기준 지문 갱신 외 쓰기 없음). validate는 마지막 화 손수정이면 재검사(모델 작업→needs_model→lore_resume), 세계·인물 변경이면 바뀐 항목과 영향받는 계획을 보여 주고 approvalId를 발급한다. apply는 그 approvalId로 새 정본을 게시한다. '
      + 'approvalId는 한 번만 쓸 수 있고 validate 이후 파일이 또 바뀌면 STALE_SYNC_CANDIDATE로 거부된다. 이전 화 손수정은 반영하지 않으므로(rewrite_refold_required) 되돌려야 한다.',
    inputSchema: { type: 'object', properties: { ...projectArg,
      action: { type: 'string', enum: ['inspect', 'validate', 'apply'], description: 'inspect(기본)=변경 분류, validate=재검사·영향 검토 후 approvalId 발급, apply=approvalId로 게시' },
      approvalId: { type: 'string', description: 'apply 전용. 가장 최근 validate가 돌려준 approvalId(sync-…). 한 번 쓰면 소진된다.' },
    }, required: ['workId'] },
  },
  {
    name: 'lore_create',
    annotations: writes(),
    description: '새 작품의 기반을 모델이 자동 설계한다: 세계 사실, 3~5인 캐스트(characters/<id>.md), 추적 엔티티를 만들어 world/setting.md와 .vibelore/에 저장한다. '
      + '보통 lore_profile → lore_profile_decide(approve) 다음에 호출하며, 그러면 StoryProfile의 엔진 장르·시점·언어·분량을 따른다. StoryProfile 없이 genre만으로도 호출할 수 있다. 직접 쓴 설정으로 시작하려면 lore_init을 쓴다. '
      + '이미 기반이 있으면 덮어쓰지 않고 거부하며, StoryProfile이 있는데 승인 전이면 거부한다. 세계·캐스트·엔티티·언어 검증마다 status=needs_model을 돌려주므로 lore_resume을 여러 번 이어야 하고, 모두 끝나기 전에는 아무 파일도 저장하지 않는다. '
      + '성공하면 {created:true, genre, language, length, worldFacts(개수), characters[{id,name,contradiction}], entities[{id,kind,name}]}. 다음 단계는 lore_story_plan.',
    inputSchema: {
      type: 'object', properties: {
        ...projectArg,
        title: { type: 'string', description: '작품 제목. 세계·캐스트 설계 입력으로도 쓰인다.' },
        brief: { type: 'string', description: '작품 전제와 방향을 담은 자연어 브리프. 승인된 StoryProfile이 있으면 그 독서 계약과 합쳐 설계 입력이 된다.' },
        genre: { type: 'string', description: '엔진 장르 id(lore_init과 같은 목록). StoryProfile이 없을 때만 필요하며, 있으면 무시하고 StoryProfile의 엔진 장르를 쓴다.' },
        povMode: { type: 'string', description: '시점(예: 3인칭제한, 1인칭). 생략하면 StoryProfile의 시점, 그것도 없으면 제한 3인칭.' },
        targetChapters: { type: 'number', description: '완결 목표 화수. 기본 40.' },
        chapterWordCount: { type: 'number', description: '구형 분량 인자. 이름과 달리 단어가 아니라 legacyCodeUnits(대략 UTF-16 글자 수)로 해석한다. 새 호출은 length를 쓴다. 둘 다 주면 unit=legacyCodeUnits이고 target이 같아야 하며 아니면 LENGTH_CONTRACT_CONFLICT.' },
        language: { ...languageArg, description: `${languageArg.description} StoryProfile이 있으면 그 언어와 같아야 한다.` },
        length: { ...lengthArg, description: `${lengthArg.description} 생략하면 StoryProfile 값, 없으면 3000(ko는 legacyCodeUnits, 그 외는 graphemes).` },
      }, required: ['workId', 'title', 'brief'],
    },
  },
  {
    name: 'lore_profile',
    annotations: writes({ destructive: true }),
    description: '새 작품 설계의 첫 단계. 작품 발견 인터뷰의 브리프를 StoryProfile(엔진 장르·독서 계약·읽기 난도·이야기 동력·시점·문체 지침·언어·분량)로 컴파일해 .vibelore/story-profile.json에 저장한다. '
      + 'review 결과의 designReview에는 누적된 설계 결정과 최대 5개의 열린 질문이 담긴다. 질문을 사용자에게 모두 보여 주고 답을 feedback으로 넘겨 다시 호출하며, 열린 질문이 없거나 사용자가 승인하면 lore_profile_decide로 확정한다. '
      + '호출할 때마다 모델이 새로 생성해 기존 프로필을 교체한다(active였어도 review면 pending으로 돌아가 이후 단계가 막힌다). 생성과 언어 검증에 status=needs_model이 1~3회 나오며 lore_resume으로 답하기 전에는 저장하지 않는다. 기반 생성 뒤에는 언어를 바꿀 수 없다.',
    inputSchema: {
      type: 'object', properties: {
        ...projectArg,
        brief: { type: 'string', description: '인터뷰에서 정리한 자연어 브리프 전체(장르·톤·방향·독자 경험). 읽기 난도 답변의 근거로도 쓰인다. 비우면 기존 작품 브리프를 쓴다.' },
        mode: { ...planModeArg, description: 'review(기본)=pending으로 저장하고 열린 질문을 돌려준다. auto=질문 없이 즉시 active. 사용자가 "알아서·묻지 말고"라고 한 경우만 auto.' },
        feedback: { type: 'string', description: '직전 라운드의 열린 질문에 대한 사용자 답변 원문. 설계 결정으로 누적된다.' },
        language: languageArg, length: lengthArg,
      }, required: ['workId', 'brief'],
    },
  },
  {
    name: 'lore_profile_decide',
    annotations: writes({ idempotent: true }),
    description: 'lore_profile이 만든 StoryProfile을 승인(active)하거나 거절(rejected)한다. 승인은 사용자가 현재 설계를 명시적으로 받아들였거나 열린 질문이 없을 때만 한다. 승인하면 읽기 난도 계약도 사용자 확인으로 기록된다. '
      + '모델 호출 없음. 프로필이 없으면 오류. 반환은 {approved, profile, instruction?}. 승인 뒤 lore_create(새 작품) 또는 lore_story_plan(기반이 이미 있을 때)으로 진행한다.',
    inputSchema: {
      type: 'object', properties: { ...projectArg, action: decideActionArg('lore_profile') },
      required: ['workId', 'action'],
    },
  },
  {
    name: 'lore_profile_status',
    annotations: READ_ONLY,
    description: 'StoryProfile만 읽기 전용으로 조회한다. 없으면 {profiled:false}, 있으면 {profiled:true, profile(status: pending|active|rejected, designReview 포함), language, length}. '
      + '새 작품을 시작하기 전에 프로필이 필요한지 판단할 때 쓴다. 작품 전체 진행은 lore_status, 설정 누락 점검은 lore_configure를 쓴다.',
    inputSchema: { type: 'object', properties: { ...projectArg }, required: ['workId'] },
  },
  {
    name: 'lore_story_plan',
    annotations: writes({ destructive: true }),
    description: '작품 전체 StorySpine(처음부터 결말까지의 인과 사슬, 인물 동력, 중간 재해석, 최종 선택의 대가)을 생성하고 구조·품질 검증을 거쳐 .vibelore/story-spine.json과 world/story-spine.md에 저장한다. '
      + '순서는 lore_create 다음, lore_writer_skill 앞이며 기반과 승인된 StoryProfile이 필요하다. 아크 단위 계획은 lore_arc_plan이 따로 만든다. '
      + '호출할 때마다 기존 StorySpine을 이력 없이 교체한다(review면 pending으로 돌아가 이후 단계가 막힌다). 생성·품질 판정·언어 검증에 status=needs_model이 약 3회 나오며 모두 답하기 전에는 저장하지 않는다. 검증에 떨어지면 오류로 끝나고 저장하지 않는다. 반환은 {spine(quality 포함), needsApproval}.',
    inputSchema: { type: 'object', properties: { ...projectArg,
      mode: planModeArg,
      direction: { type: 'string', description: '작품 전체 방향에 대한 작가 지시. 생략하면 작품 브리프를 쓴다.' },
      feedback: { type: 'string', description: '거절한 StorySpine을 다시 만들 때 반영할 사용자 피드백. 이전 StorySpine은 모델에 다시 보내지 않으므로 피드백만으로 이해되게 쓴다.' },
    }, required: ['workId'] },
  },
  {
    name: 'lore_story_decide',
    annotations: writes({ idempotent: true }),
    description: 'lore_story_plan이 만든 StorySpine을 승인(active)하거나 거절(rejected)한다. 사용자가 StorySpine 내용을 보고 결정한 뒤 호출한다. 모델 호출 없음. StorySpine이 없으면 오류. '
      + '반환은 {approved, spine}. 승인 뒤 다음 단계는 lore_writer_skill.',
    inputSchema: { type: 'object', properties: { ...projectArg, action: decideActionArg('lore_story_plan') }, required: ['workId', 'action'] },
  },
  {
    name: 'lore_story_status',
    annotations: READ_ONLY,
    description: 'StorySpine만 읽기 전용으로 조회한다. 없으면 {planned:false}, 있으면 {planned:true, spine(status: pending|active|rejected, 인과 사슬·인물 동력·quality)}. '
      + '아크 계획은 lore_arc_status, 작품 전체 진행은 lore_status로 본다.',
    inputSchema: { type: 'object', properties: { ...projectArg }, required: ['workId'] },
  },
  {
    name: 'lore_writer_skill',
    annotations: writes({ destructive: true }),
    description: '이 작품을 쓸 WriterSkill(장면 판단·정보 지연·보상 지급·반복 고착 방지 방식)을 서로 다른 후보 3개로 만들고, 후보별 짧은 산문 오디션을 판정 모델이 비교해 하나를 고른다. 표면 문체가 아니라 서술 판단을 설계한다. '
      + '순서는 lore_story_decide(approve) 다음, lore_arc_plan 앞이며 기반과 승인된 StorySpine이 필요하다. 문체 예시를 고정하는 lore_style_anchor와는 다르다. '
      + '호출할 때마다 기존 WriterSkill을 이력 없이 교체해 .vibelore/writer-skill.json과 world/writer-skill.md에 저장한다. 후보 생성·오디션 판정·언어 검증에 status=needs_model이 약 3회 나온다. 반환은 {skill(선택 후보와 점수), candidates, needsApproval}.',
    inputSchema: { type: 'object', properties: { ...projectArg,
      mode: planModeArg,
      feedback: { type: 'string', description: '거절 이유나 원하는 서술 방향. 다음 후보 생성에 반영된다.' },
    }, required: ['workId'] },
  },
  {
    name: 'lore_writer_decide',
    annotations: writes({ idempotent: true }),
    description: 'lore_writer_skill이 오디션으로 고른 WriterSkill을 승인(active)하거나 거절(rejected)한다. 다른 후보로 바꾸는 기능은 없으므로 원하지 않으면 거절 후 feedback과 함께 다시 생성한다. '
      + '모델 호출 없음. WriterSkill이 없으면 오류. 반환은 {approved, skill}. 승인 뒤 다음 단계는 lore_arc_plan.',
    inputSchema: { type: 'object', properties: { ...projectArg, action: decideActionArg('lore_writer_skill') }, required: ['workId', 'action'] },
  },
  {
    name: 'lore_writer_status',
    annotations: READ_ONLY,
    description: 'WriterSkill만 읽기 전용으로 조회한다. 없으면 {planned:false}, 있으면 {planned:true, skill(status: pending|active|rejected, 선택 후보, 후보 3개와 오디션 산문·점수)}. '
      + '사용자에게 오디션 결과를 보여 줄 때 쓴다. 문체 기준 예시는 lore_style_anchor, 작품 전체 진행은 lore_status로 본다.',
    inputSchema: { type: 'object', properties: { ...projectArg }, required: ['workId'] },
  },
  {
    name: 'lore_draft',
    annotations: writes(),
    description: '현재 세계·인물·이전 상태·최근 요약을 바탕으로 다음 화 초고를 생성한다. 결과는 아직 저장하지 않으며 lore_check를 거쳐야 한다.',
    inputSchema: {
      type: 'object', properties: {
        ...projectArg, chapter: { type: 'integer', minimum: 1 }, plan: { type: 'string' }, targetChars: { type: 'number' },
        language: { type: 'string', description: '작품 언어 BCP 47 태그(예: ko, en-US, ja, zh-Hant). 생략하면 저장된 계약을 따른다.' }, length: { type: 'object', description: '화당 분량 계약. unit 은 legacyCodeUnits|graphemes|words.', properties: { unit: { type: 'string', enum: ['legacyCodeUnits', 'graphemes', 'words'] }, target: { type: 'number' } }, required: ['unit', 'target'] },
        tension: { type: 'object', properties: { ticking: { type: 'string' }, stake: { type: 'string' }, escalation: { type: 'string' } } },
      }, required: ['workId', 'chapter'],
    },
  },
  {
    name: 'lore_revise',
    annotations: writes(),
    description: 'lore_check 위반 목록을 받아 문제 구간만 최소 수정한 전체 본문을 생성한다. 결과는 다시 검사해야 한다.',
    inputSchema: {
      type: 'object', properties: {
        ...projectArg, chapter: { type: 'integer', minimum: 1 }, prose: { type: 'string' },
        violations: { type: 'array', items: { type: 'object' } },
      }, required: ['workId', 'chapter', 'prose', 'violations'],
    },
  },
  {
    name: 'lore_rewrite',
    annotations: writes(),
    description: '저장된 한 화를 작가의 의도에 맞춰 전면 다시 쓴 초안을 생성한다. 자동 저장하지 않으며 검사·커밋·재접기가 필요하다.',
    inputSchema: {
      type: 'object', properties: { ...projectArg, chapter: { type: 'integer', minimum: 1 }, intent: { type: 'string' } },
      required: ['workId', 'chapter', 'intent'],
    },
  },
  {
    name: 'lore_next_arc',
    annotations: writes(),
    description: '누적 요약·활성 인물·엔티티에서 다음 5~50화 아크의 약속, 무대, 이어갈 인물과 전환 훅을 제안한다.',
    inputSchema: {
      type: 'object', properties: { ...projectArg, currentArc: { type: 'object' } }, required: ['workId'],
    },
  },
  {
    name: 'lore_arc_plan',
    annotations: writes({ destructive: true }),
    description: '다음 아크의 약속과 3~20개 얇은 회차 비트(사건·압력·전환·다음 상태)를 생성하고 구조·품질 검증을 거쳐 .vibelore/arc-plan.json에 저장한다(아크별 사본은 .vibelore/arcs/). '
      + 'lore_write 전에 lore_arc_status로 활성 아크가 없음을 확인했을 때, 또는 아크가 끝났을 때 호출한다. 기반과 승인된 StoryProfile·StorySpine·WriterSkill이 필요하다. '
      + '현재 계획을 무조건 교체한다: pending이면 같은 번호로 덮어쓰고, 진행 중인 활성 아크도 다음 번호의 새 아크로 대체하므로 아크 중간에는 호출하지 않는다. 생성·품질 판정·언어 검증에 status=needs_model이 약 3회 나온다. 반환은 {plan(episodes, quality), needsApproval, instruction}.',
    inputSchema: {
      type: 'object', properties: {
        ...projectArg,
        mode: { ...planModeArg, description: 'review(기본)=사용자 승인 전까지 pending이며 집필할 수 없다. auto=검증 통과 즉시 활성화. 사용자가 "알아서·묻지 말고"라고 한 경우만 auto.' },
        episodes: { type: 'number', description: '아크 화수 3~20(범위 밖은 잘라낸다). 기본 8.' },
        direction: { type: 'string', description: '사용자가 원하는 아크 방향. 비우면 작품 브리프와 StorySpine에서 자율 설계.' },
        feedback: { type: 'string', description: '거절한 계획을 다시 만들 때 반영할 피드백. 이전 계획은 모델에 다시 보내지 않으므로 피드백만으로 이해되게 쓴다.' },
      }, required: ['workId'],
    },
  },
  {
    name: 'lore_arc_decide',
    annotations: writes({ idempotent: true }),
    description: 'lore_arc_plan이 만든 아크 계획을 승인해 활성화하거나 거절한다. 사용자가 계획을 보고 결정한 뒤 호출한다. 활성 아크가 있어야 lore_write가 집필할 수 있고, 활성 아크를 거절하면 lore_write가 ARC_NOT_ACTIVE로 멈춘다. '
      + '생성 뒤 새 화가 게시됐으면 승인이 status=clean_fail(STALE_VALIDATION_RECEIPT)로 거부되므로 다시 계획한다. 모델 호출 없음. 반환은 {approved, plan, instruction?}.',
    inputSchema: {
      type: 'object', properties: { ...projectArg, action: decideActionArg('lore_arc_plan') },
      required: ['workId', 'action'],
    },
  },
  {
    name: 'lore_arc_status',
    annotations: READ_ONLY,
    description: '현재 아크 계획을 읽기 전용으로 조회한다. 집필 요청을 받으면 가장 먼저 호출해 활성 아크가 있는지 확인한다. '
      + '없으면 {planned:false}, 있으면 {planned:true, plan(status: pending|active|rejected|completed, episodes), nextChapter, currentEpisode}. currentEpisode는 활성 아크에 다음 화 비트가 있을 때만 채워지며, null이면 lore_arc_plan이 필요하다.',
    inputSchema: { type: 'object', properties: { ...projectArg }, required: ['workId'] },
  },
  {
    name: 'lore_arc_review',
    annotations: writes(),
    description: '현재 아크에서 이미 쓴 화들을 5화 단위 체크포인트 또는 종결화까지 다시 읽고, 화별 PatternLedger와 아크 품질 리뷰(7개 차원 점수·발견 사항)를 새로 만든다. '
      + 'lore_write가 체크포인트마다 같은 리뷰를 자동으로 하므로 선택 도구이며, 리뷰를 수동으로 갱신하거나 다시 보고 싶을 때만 쓴다. 결과는 advisory이고 원고를 고치지 않는다. '
      + '.vibelore/experience-ledger.json·pattern-ledger.json과 arc-reviews/를 덮어쓴다. 화마다 한 번, 마지막에 한 번 status=needs_model이 나온다(N+1회). 체크포인트가 아닌 화나 본문이 없는 화를 지정하면 오류.',
    inputSchema: {
      type: 'object', properties: { ...projectArg, throughChapter: { type: 'number', description: '평가 종료 화(아크 5·10·15화째 또는 마지막 화). 생략하면 현재 아크의 마지막 작성 화이며, 그 화가 체크포인트가 아니면 오류.' } },
      required: ['workId'],
    },
  },
  {
    name: 'lore_episode_plan',
    annotations: writes({ destructive: true }),
    description: '승인된 현재 아크 비트를 즉시 목표→장애물→선택→결과와 2~4개 얇은 흐름 단위로 확장한다. 인물 agenda·충돌·반전 계약·말투 목표는 실제로 필요한 회차에만 선택적으로 붙인다.',
    inputSchema: {
      type: 'object', properties: {
        ...projectArg, chapter: { type: 'integer', minimum: 1 }, mode: { type: 'string', enum: ['review', 'auto'] },
        direction: { type: 'string' }, feedback: { type: 'string' },
      }, required: ['workId', 'chapter'],
    },
  },
  {
    name: 'lore_episode_decide',
    annotations: writes({ idempotent: true }),
    description: '검토 대기 EpisodePlan을 승인하거나 거절한다.',
    inputSchema: {
      type: 'object', properties: { ...projectArg, chapter: { type: 'integer', minimum: 1 }, action: { type: 'string', enum: ['approve', 'reject'] } },
      required: ['workId', 'chapter', 'action'],
    },
  },
  {
    name: 'lore_episode_status',
    annotations: READ_ONLY,
    description: '특정 화의 상세 EpisodePlan과 승인·완료 상태를 확인한다.',
    inputSchema: { type: 'object', properties: { ...projectArg, chapter: { type: 'integer', minimum: 1 } }, required: ['workId', 'chapter'] },
  },
  {
    name: 'lore_refold',
    annotations: writes({ destructive: true }),
    description: '앞 화를 다시 커밋한 뒤 저장된 모든 화 델타를 순서대로 다시 접어 이후 StoryState를 재계산한다.',
    inputSchema: {
      type: 'object', properties: { ...projectArg, fromChapter: { type: 'integer', minimum: 1 } }, required: ['workId'],
    },
  },
  {
    name: 'lore_snapshot_status',
    annotations: READ_ONLY,
    description: 'lore_rollback으로 되돌아갈 수 있는 화 번호 목록을 읽기 전용으로 조회한다. 스냅숏은 커밋할 때마다 .vibelore/snapshots/<화>/에 자동 생성되며 같은 화를 다시 커밋하면 교체된다. '
      + '반환은 {snapshots:[화 번호 오름차순]}이며 생성 시각 같은 상세는 없다. 롤백 전에 대상 화가 있는지 확인할 때 쓴다.',
    inputSchema: { type: 'object', properties: { ...projectArg }, required: ['workId'] },
  },
  {
    name: 'lore_rollback',
    annotations: writes({ destructive: true }),
    description: '지정 화의 스냅숏으로 정본과 기계 상태를 되돌린다. 사용자가 이미 커밋된 화들을 취소하겠다고 명시했을 때만 호출하고, 먼저 lore_snapshot_status로 대상 화를 확인한다. 손수정 반영은 lore_sync를 쓴다. '
      + '파괴적: world/·characters/·chapters/·summaries/를 지우고 스냅숏으로 복원하므로 그 화 이후 원고가 작업 트리에서 사라진다. 진행 중인 워크플로, 대기 중인 lore_resume runId, 검사 영수증도 지워지고 이후의 lore_configure·lore_style_anchor 변경도 되돌아간다. '
      + '되돌리기 전 상태는 .vibelore/rollback-archives/<id>/에 보존되지만 복원 도구는 없어 수동으로 되살려야 한다. 모델 호출 없음. 반환은 {rolledBackTo, archiveId, archive, recoverable:true, publication}.',
    inputSchema: { type: 'object', properties: { ...projectArg, chapter: { type: 'integer', minimum: 1, description: '되돌아갈 화 번호. 그 화까지의 원고가 남는다.' } }, required: ['workId', 'chapter'] },
  },
  {
    name: 'lore_era_research',
    annotations: writes(),
    description: '호스트 LLM의 웹 검색 능력을 이용해 본문의 시대·지역 고증 주장을 확인한다. 모르는 내용은 uncertain으로 남기고 출처가 있는 충돌만 soft 위반으로 보고한다.',
    inputSchema: {
      type: 'object', properties: {
        ...projectArg, chapter: { type: 'integer', minimum: 1 }, era: { type: 'string' },
        claims: { type: 'array', items: { type: 'string' } }, maxCalls: { type: 'number' },
      }, required: ['workId', 'chapter', 'claims'],
    },
  },
  {
    name: 'lore_resume',
    annotations: writes({ destructive: true }),
    description:
      'status=needs_model 로 중단된 작업을 이어받는다. requests 의 각 질문에 답한 텍스트를 answers 에 { id: 답변 } 형태로 넘기면 중단 지점부터 계속한다. 한 응답의 requests는 서로 독립이므로 모두 답해 한 번에 넘긴다. '
      + '원래 도구를 처음 받은 인자 그대로 다시 실행하므로 인자를 바꾸려면 원래 도구를 새로 호출한다. 재개된 도구의 부작용(저장·교체·커밋)을 그대로 가진다. 다음 단계에 새 모델 작업이 필요하면 새 requests와 함께 needs_model을 다시 돌려주므로 여러 번 이어지는 것이 정상이다. '
      + '빈 answers나 맞지 않는 id는 작업을 끝내지 않고 같은 requests를 다시 돌려준다. runId는 첫 생성 후 24시간 뒤 만료되고 완료되면 삭제된다. 답을 멈추면 소설·설계 도구는 needs_model 응답의 deterministicResult가 유일한 결과이고(lore_write는 멈춘 workflow 식별 정보뿐이며 awaiting_model로 남는다), 웹툰은 같은 단계에서 대기하며 lore_workflow_status(lane=webtoon)로 확인한다.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        runId: { type: 'string', description: 'needs_model 응답의 runId(run-…). lore_write의 runId를 잃었으면 lore_workflow_status의 resume.runId로 찾는다.' },
        answers: { type: 'object', description: '{ 질문 id: 모델이 만든 답변 텍스트 }. 이전 라운드에 보낸 답은 저장돼 있으므로 새 질문만 보내면 된다. jsonMode 요청은 코드 펜스 없는 순수 JSON으로 답한다.' },
      },
      required: ['runId'],
    },
  },
  {
    name: 'lore_write',
    annotations: writes(),
    description: '다음 화의 계획 확인부터 원본 초고 프롬프트, 의미·논리 검사(최대 3회, 그 사이 최소 수정 최대 2회), 검사 영수증, 승인·커밋까지 순서대로 실행하는 기본 집필 도구다. 소설을 이어 쓸 때는 이 도구만 호출한다. '
      + '항상 마지막 화의 다음 화를 쓰며 기존 화를 덮어쓰지 않는다. 같은 화의 진행 중 워크플로가 있으면 새로 만들지 않고 이어간다. 모델 작업마다 status=needs_model을 돌려주므로 lore_resume으로 답한다. '
      + '준비가 덜 됐으면 status=needs_setup(FOUNDATION_MISSING·PROFILE_NOT_ACTIVE·STORY_SPINE_NOT_ACTIVE·WRITER_SKILL_NOT_ACTIVE·ARC_NOT_ACTIVE), 손수정이 있으면 needs_sync(→lore_sync)를 돌려준다. '
      + 'guided는 검사를 마친 원고를 status=awaiting_approval과 approvalId로 돌려주며 lore_decide로 결정한다. auto는 검사를 통과하면 chapters/·summaries/·상태·스냅숏을 커밋하고 status=completed를 돌려준다. 실패는 clean_fail·validation_incomplete·provider_error.',
    inputSchema: {
      type: 'object', properties: {
        ...projectArg,
        retryValidation: { type: 'boolean', description: '실패 상태의 보존된 원고를 새 검증 epoch에서 다시 검사한다.' },
        instruction: { type: 'string', description: '이번 화에 추가할 작가 지시.' },
        autonomy: { type: 'string', enum: ['guided', 'auto'], description: 'guided(기본)=완성 원고 승인 후 커밋, auto=품질 통과 시 자동 커밋. 커밋 여부는 그 호출의 값으로 정해지므로 auto를 원하면 이어 부르는 lore_write에도 다시 넘긴다.' },
        modelProfile: {
          type: 'object', additionalProperties: false,
          description: '단계별 모델 힌트. 비우면 호스트 기본 모델 하나로 진행한다. 값은 모델 ID 문자열 또는 { provider, modelId, reasoningEffort }. default=기준 모델, light=planning·draft·review에 쓸 가벼운 모델, identity·planning·draft·review·quality·final=단계별 명시. review=advisory 검토(coherence·editorial·character·reader·arc·profile drift), quality=상태를 쓰는 추출·연속성 검사·pattern ledger. 호스트 릴레이에서는 요청마다 힌트로 전달되고, 로컬 모델은 provider "local"일 때만 실제로 바뀐다.',
          properties: Object.fromEntries(['default', 'light', 'identity', 'planning', 'draft', 'review', 'quality', 'final'].map((key) => [key, {
            anyOf: [
              { type: 'string', minLength: 1, maxLength: 120 },
              { type: 'object', additionalProperties: false, properties: {
                provider: { type: 'string', maxLength: 40 }, modelId: { type: 'string', maxLength: 120 },
                reasoningEffort: { type: 'string', enum: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
              } },
            ],
          }])),
        },
        language: { type: 'string', description: '저장된 작품 언어와 일치하는지 확인하는 인자. 일회성 출력 언어 변경이 아니다.' },
        sharedOnce: { type: 'boolean', description: 'true면 needs_model 응답에 공통 본문 블록을 sharedBlocks로 한 번만 싣고, 각 request user 맨 앞 promptCache.sharedBlockRef 문자열(줄바꿈 포함)을 그 블록 text로 바꿔 보내게 한다. 요청을 직접 조립하는 호스트용이며 기본값은 자기완결 요청이다.' },
      }, required: ['workId'],
    },
  },
  {
    name: 'lore_decide',
    annotations: writes(),
    description: 'lore_write가 guided 모드에서 status=awaiting_approval로 돌려준 원고에 대한 사용자 결정을 적용한다. 사용자에게 원고와 advisory를 보여 주고 답을 받은 뒤에만 호출한다. '
      + 'approve는 검사 영수증을 다시 확인하고 그 화를 커밋한다(chapters/·summaries/·상태·스냅숏, status=completed). request_revision은 feedback대로 같은 워크플로에서 고치게 하며 다음 lore_write가 수정·재검사한다. hold는 기록만 남기고 승인 대기를 유지한다. reject는 워크플로를 끝내며 다음 lore_write가 같은 화를 새로 쓴다. 원고 파일은 지우지 않는다. '
      + 'approvalId는 원고가 승인 대기에 다시 들어갈 때마다 새로 발급되므로 이전 id는 거부된다.',
    inputSchema: {
      type: 'object', properties: {
        ...projectArg,
        approvalId: { type: 'string', description: '직전 lore_write(awaiting_approval) 응답의 approvalId.' },
        action: { type: 'string', enum: ['approve', 'request_revision', 'hold', 'reject'], description: 'approve=커밋, request_revision=feedback대로 수정, hold=보류, reject=폐기 후 새로 쓰기.' },
        feedback: { type: 'string', description: 'request_revision에 필수인 구체적 수정 요청. reject에는 선택이며 기록만 된다.' },
      }, required: ['workId', 'approvalId', 'action'],
    },
  },
  {
    name: 'lore_workflow_status',
    annotations: READ_ONLY,
    description: '진행 중인 한 화(또는 웹툰 장면) 워크플로의 현재 단계, 시도 횟수, 다음 행동과 품질 결과를 읽기 전용으로 조회한다. 작품 전체 진행은 lore_status, 지난 이벤트는 lore_workflow_history를 쓴다. '
      + '소설은 {active, workflow(원고 본문 제외), resume?}를 돌려주며 워크플로가 없으면 {active:false}. 모델 응답 대기 중이면 resume.runId로 lore_resume을 이어갈 수 있다. lane=webtoon은 현재 웹툰 워크플로 상태를 돌려주며 status가 곧 단계다.',
    inputSchema: { type: 'object', properties: { ...projectArg,
      lane: { type: 'string', enum: ['prose', 'webtoon'], description: 'prose(기본)=소설 집필, webtoon=웹툰 제작.' },
      workflowId: { type: 'string', description: 'webtoon 전용. 조회할 워크플로 id. 생략하면 현재 워크플로. prose는 항상 현재 워크플로를 본다.' },
      detail: { type: 'string', enum: ['summary', 'full'], description: 'webtoon 전용. 기본 summary. 상세 계획/참조가 필요할 때 full.' },
    }, required: ['workId'] },
  },
  {
    name: 'lore_workflow_history',
    annotations: READ_ONLY,
    description: '워크플로의 감사 이력(단계 전환·검토 발견·승인·커밋 이벤트)을 읽기 전용으로 조회한다. 현재 상태만 필요하면 lore_workflow_status를 쓴다. '
      + '반환은 {found, workflowId, events, modelExchanges?}. includeModelExchanges=true이면 선택된 이벤트의 실제 모델 요청과 응답 전문까지 돌려주므로 응답이 커진다. 대체된 이전 워크플로도 id로 조회할 수 있다.',
    inputSchema: { type: 'object', properties: { ...projectArg,
      lane: { type: 'string', enum: ['prose', 'webtoon'], description: 'prose(기본)=소설 집필, webtoon=웹툰 제작.' },
      workflowId: { type: 'string', description: '조회할 워크플로 id. 생략하면 현재 워크플로.' },
      limit: { type: 'number', description: 'prose 전용. 최근 이벤트 몇 개를 돌려줄지. 기본 100. webtoon은 전체를 돌려준다.' },
      includeModelExchanges: { type: 'boolean', description: 'true면 이벤트가 참조한 모델 요청·응답 전문을 포함한다. 기본 false. 웹툰 장면 워크플로에서는 무시된다.' },
    }, required: ['workId'] },
  },
  {
    name: 'lore_workflow_inspect',
    annotations: READ_ONLY,
    description: '특정 또는 현재 워크플로의 상세 상태를 확인한다. 소설은 상세 상태와 검사 영수증을 주고, detail=full일 때만 보존·승인 대기 원고(draftProse)를 포함한다. 모델 응답은 제외한다. lane=webtoon의 full은 원작·계획 상세를 포함할 수 있으므로 필요한 경우만 사용한다.',
    inputSchema: { type: 'object', properties: { ...projectArg, lane: { type: 'string', enum: ['prose', 'webtoon'] }, workflowId: { type: 'string' }, detail: { type: 'string', enum: ['summary', 'full'] } }, required: ['workId'] },
  },
  {
    name: 'lore_webtoon_scene',
    annotations: writes(),
    description: '기본 웹툰 제작 경로. 소설 정본의 한 장면을 대사가 작품 언어 원문으로 들어간 이미지 한 장으로 만든다. 원작→영어 장면 연출→생성 전 검증→문자 포함 장면 이미지→실제 시각 검토 순서이며 컷 배치와 카메라는 이미지 모델에 맡긴다. 호출 전에 webtoon-discovery-interview로 원작 범위·화풍·참조·칸 수·이미지 모델을 사용자와 정한다. '
      + '서버는 이미지를 직접 생성하지 않는다: needs_scene_image일 때 jobs의 요청을 호스트가 사용자가 고른 경로(hostRequest=호스트 내장 도구, apiRequest=API·별도 과금)로 실행하고 결과 파일을 asset으로 넘긴다. 선택이 없는 작품은 start가 needs_image_runtime으로 호스트의 실제 이미지 경로 보고(imageRuntime)를 받고, needs_image_choice로 선택지 전체를 사용자에게 보여 확정한다(내장 경로를 먼저 제안). 확정한 선택은 changeImageChoice로 바꾸기 전까지 재사용한다. 모델 단계(연출·검증·시각 검토)는 needs_model→lore_resume, 칸 수가 없으면 needs_interview. '
      + '상태는 .vibelore/webtoon/에 저장하고 소설 정본과 프로젝트 webtoon/ 폴더는 건드리지 않는다. 진행 중 워크플로가 있으면 start는 WEBTOON_WORKFLOW_ACTIVE로 거부되므로 revise나 retry로 끝낸다. 시각 검토를 통과하면 status=completed. 기존 컷별 workflow는 변경하지 않는다.',
    inputSchema: { type: 'object', properties: { ...projectArg,
      workflowId: { type: 'string', description: '대상 장면 워크플로 id. 생략하면 현재 워크플로.' }, revision: webtoonRevisionArg,
      action: { type: 'string', enum: ['start', 'revise', 'retry'], description: 'start=새 장면 워크플로 시작, revise=feedback으로 연출부터 다시(완료된 장면도 다시 연다), retry=scene_model_failed에서 실패 단계 재시도. 생략하면 현재 단계를 이어간다(대기 중 모델 요청 재전송, jobs 반환, asset 반입).' },
      sourceChapters: { type: 'array', items: { type: 'integer' }, description: 'start 전용. 각색할 소설 화 번호(1~20개). 생략하면 첫 화만.' },
      panelCount: { anyOf: [{ type: 'integer', minimum: SCENE_PANEL_LIMITS.min, maximum: SCENE_PANEL_LIMITS.max }, { type: 'string', enum: ['auto'] }], description: `사용자가 선택한 정확한 칸 수(${SCENE_PANEL_LIMITS.min}~${SCENE_PANEL_LIMITS.max}) 또는 "auto". auto는 각색할 때마다 AI가 ${SCENE_PANEL_LIMITS.autoMin}~${SCENE_PANEL_LIMITS.max}칸 중 적정 수를 다시 고른다. ${SCENE_PANEL_LIMITS.continuityMin}칸 미만은 연속성 경고가 warnings에 실린다. start에서 누락하면 needs_interview. 칸 크기와 배치는 AI가 선택.` },
      previousWorkflowId: { type: 'string', description: '이어지는 직전 장면 workflow. 실제 이미지·설계·검토 결과를 상속해 연속성을 검증하며 이전 검토 판정은 그대로 보존.' },
      sourceUnitIds: { type: 'array', items: { type: 'string' }, description: '고정된 원작 문단 ID. 생략 시 선택 회차 전체. 한 이미지에 담을 장면 범위로 지정한다.' },
      direction: { type: 'string', description: '사용자가 확정한 작화·문자·판면/배치 재량을 영어로 전달(대사는 작품 언어 원문 그대로 이미지에 들어간다).' },
      references: { type: 'array', description: 'start 필수. 사용자가 지정한 인물·배경 참조 이미지 1개 이상(직전 장면 포함 최대 16개). description은 영어, id에 previous-scene은 쓸 수 없다.', items: { type: 'object', properties: { id: { type: 'string' }, path: { type: 'string' }, hash: { type: 'string' }, description: { type: 'string' } }, required: ['id', 'path', 'hash', 'description'] } },
      autoRevisions: { type: 'integer', minimum: 0, maximum: SCENE_AUTO_REVISIONS.max, description: `start 전용. 생성 전 검증 또는 이미지 검토가 불합격이면 관측 결함을 feedback으로 자동 재설계하는 횟수(기본 ${SCENE_AUTO_REVISIONS.default}). 재설계마다 새 이미지 요청이 나가며 실패한 시도는 attempts에 남는다. 0이면 기존처럼 scene_needs_revision에서 멈춘다.` },
      feedback: { type: 'string', description: 'revise에 필수인 수정 요청. confirmImageChoice와 함께 start할 때는 과금 선택에 대한 사용자 원답을 넣는다.' },
      asset: { type: 'object', description: 'needs_scene_image 단계에서 호스트가 생성한 장면 이미지. path는 프로젝트 안의 PNG/JPEG, inputHash는 job의 inputHash, provenance는 선택한 경로대로 내장이면 {kind:"host-built-in", provider, tool, selectionId, observedModel?}, API면 {kind:"api", provider, requestedModel, selectionId, observedModel?}(기존 OpenAI 선택 작품은 {kind:"openai-api", requestedModel, selectionId}). observedModel은 호스트가 실제로 본 것만 적는다.', properties: { path: { type: 'string' }, inputHash: { type: 'string' }, provenance: { type: 'object' } }, required: ['path', 'inputHash', 'provenance'] },
      imageRuntime: { type: 'object', description: 'start 전용. needs_image_runtime에 답해 호스트가 실제로 쓸 수 있는 이미지 경로를 보고한다. {host, options:[{id, execution:"host-built-in"|"api", provider, tool?, modelSelectable, models[], credential?, note?}]}. 내장 도구와 API 경로를 모두 적고, 모르는 것은 추측하지 말고 note에 쓴다. 모델 인자는 받지만 계정 모델을 모르면 models를 비운다(고를 때 imageModel 필요). 키 값은 넣지 않는다.',
        properties: { host: { type: 'string' }, options: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, execution: { type: 'string', enum: ['host-built-in', 'api'] }, provider: { type: 'string' }, tool: { type: 'string' }, modelSelectable: { type: 'boolean' }, models: { type: 'array', items: { type: 'string' } }, credential: { type: 'string' }, note: { type: 'string' } }, required: ['id', 'execution', 'provider', 'modelSelectable'] } } }, required: ['host', 'options'] },
      imageOption: { type: 'string', description: 'start 전용. 사용자가 고른 imageRuntime.options[].id. 생략하면 내장 경로를 먼저 제안한다.' },
      imageModel: { type: 'string', description: 'start 전용. 고른 경로가 모델을 받을 때 사용자가 고른 모델(그 경로의 models 중 하나). 생략하면 gpt-image-2.5-sunburst가 있으면 그것, 없으면 첫 모델.' },
      changeImageChoice: { type: 'boolean', description: 'start 전용. 사용자가 이 작품의 이미지 경로·모델을 바꾸겠다고 했을 때만 true. 저장된 선택을 두고 새 선택을 다시 묻는다.' },
      confirmImageChoice: { type: 'string', description: 'needs_image_choice로 받은 imageChoice.id. 사용자의 원답을 feedback에 넣어 같은 start를 다시 호출하면 이 작품의 선택으로 확정한다. imageRuntime을 다시 보낼 필요는 없다.' },
    }, required: ['workId'] },
  },
  {
    name: 'lore_webtoon_plan',
    annotations: writes({ destructive: true }),
    description: '[deprecated] 새 작업은 lore_webtoon_scene을 사용한다. 진행 중인 컷별 작업의 인터뷰·각색 이어가기 전용. 소설 원작을 고정한 뒤 만화 제작 인터뷰·방향 승인·각색·콘티 검토를 이어간다. 새 컷별 작업 시작과 종료된 작업의 newWorkflow는 WEBTOON_PANEL_PATH_DEPRECATED로 거부된다. 페이지형은 needs_format_support로 대기하며 세로형으로 자동 대체하지 않는다. needs_interview는 사용자 질문, needs_model은 lore_resume 모델 응답이다. '
      + '상태는 .vibelore/webtoon/에 저장하고, mode=auto에서는 승인 관문을 자동 통과시켜 프로젝트 webtoon/profile.md 등을 덮어쓴다. direction·feedback·responses를 주면 인터뷰 단계로 되돌아가 이후 계획이 초기화된다.',
    inputSchema: { type: 'object', properties: { ...projectArg,
      workflowId: { type: 'string', description: '이어갈 컷별 워크플로 id. 생략하면 현재 워크플로.' }, revision: webtoonRevisionArg,
      mode: { type: 'string', enum: ['review', 'auto'], description: 'review(기본)=관문마다 사용자 승인, auto=추천값으로 채우고 관문 자동 승인. 인터뷰 단계에서만 바꿀 수 있다.' },
      sourceChapters: { type: 'array', items: { type: 'integer' }, description: '워크플로 생성 때 고정된 원작 화. 다른 값을 주면 WEBTOON_SCOPE_ALREADY_PINNED.' },
      episode: { type: 'integer', description: '생성 때 고정된 웹툰 회차 번호(기본 1).' },
      maxShots: { type: 'integer', description: '생성 때 고정된 컷 수 상한(기본 40, 1~120). 목표가 아니라 상한이다.' },
      segmented: { type: 'boolean', description: '이미 시작된 컷별 작업의 분할 제작 여부(시작 때 정해지며 바꿀 수 없다). 공통 지침/회차 개요 → 장면당 최대6컷 각색 → 인접 컷 포함 부분 검토 → 전체 흐름 검토. 조판도 장면별 분할.' },
      imageModel: { type: 'string', enum: ['gpt-image-2', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare'], description: '진행 중인 컷별 작업의 현재 요청 모델과 같아야 한다(변경은 lore_webtoon_render에서). 이 경로로 새 작업은 시작할 수 없다.' },
      direction: { type: 'string', description: '사용자가 정한 작화·연출 방향. 주면 인터뷰 단계로 돌아간다.' },
      feedback: { type: 'string', description: '사용자 원답이나 수정 요청. 주면 인터뷰 단계로 돌아가 근거로 기록된다. adoptEdits에 필수.' },
      responses: { type: 'object', additionalProperties: { type: 'string' }, description: '사용자 선택만 전달. W04는 자유 작화 설명, W15는 standard|soft|minimal 또는 지원 설정 JSON 문자열, W16은 scroll|page-ltr|page-rtl. 자유로운 원답은 feedback으로 전달해 근거를 보존하며 정리한다. 기본 선택 표시나 무응답을 승인으로 만들지 않는다.' },
      retry: { type: 'boolean', description: 'model_failed에서 실패한 모델 단계를 재시도(최대 3회)하거나, plan_invalid·editorial_invalid에서 실패 사유를 반영해 다시 생성한다.' },
      newWorkflow: { type: 'boolean', description: '더 이상 쓰지 않는다. 항상 거부되며 새 작업은 lore_webtoon_scene으로 시작한다.' },
      adoptEdits: { type: 'boolean', description: '사람이 프로젝트 webtoon/ 파일을 고쳐 WEBTOON_WORKING_TREE_DRIFT가 났을 때 그 편집을 입력으로 받아들이고 인터뷰부터 다시 진행한다. feedback 필수.' },
    }, required: ['workId'] },
  },
  {
    name: 'lore_webtoon_render',
    annotations: writes(),
    description: '[deprecated] 진행 중인 컷별 작업 마무리 전용. 새 작업은 lore_webtoon_scene을 사용한다. 승인 계획의 이미지 요청과 조판을 관리한다. 새 계획은 대사·독백·설명·효과음과 사물 글자를 구분한다. 사물 글자는 이미지에 포함하고 실제 읽힘·표면 검토 후 중복 조판하지 않는다. needs_image_choice에서 모델·내장/API·비용을 확인하고 사용자 선택을 작품별로 계속 사용한다. API는 호스트가 실행하고 서버는 모델·참조·반입·승인을 관리한다. 실행 불가는 needs_image_runtime, revisionTarget.kind=lettering은 조판만 수정한다. '
      + '후보 파일은 .vibelore/webtoon/에 쓰며 프로젝트 webtoon/에는 lore_webtoon_decide 승인 때만 반영된다. 조판 분석·렌더 검토는 needs_model→lore_resume.',
    inputSchema: { type: 'object', properties: { ...projectArg,
      workflowId: { type: 'string', description: '대상 컷별 워크플로 id(필수). 장면 워크플로는 USE_WEBTOON_SCENE_TOOL로 거부된다.' }, revision: webtoonRevisionArg,
      detail: { type: 'string', enum: ['summary', 'full'], description: 'summary는 반복되는 계획·참조 상세를 생략한다. jobs·승인 ID·검토 실패는 유지한다.' },
      reviewAccess: { type: 'object', properties: { available: { type: 'boolean' }, reason: { type: 'string' } }, required: ['available', 'reason'], description: '호스트가 확인한 합성본 열람 가능 여부. false이면 불가능한 검토 호출을 생략하고 미완료 승인 대기로 내린다. true는 검토 완료나 보안 제한 우회 허가가 아니다. 대기 요청/승인 중에는 변경하지 않는다.' },
      quality: { type: 'string', enum: ['references', 'preview', 'final'], description: 'references=인물·배경 참조 이미지 생성·승인(참조가 없으면 강제), preview(기본)=일부 컷과 조판으로 룩 승인, final=룩 승인 뒤 전체 컷.' },
      imageModel: { type: 'string', enum: ['gpt-image-2', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare'], description: '이미지가 없는 승인 계획에서 모델을 제안한다. needs_image_choice를 확인·확정한 뒤 새 계획 승인을 받는다. 이후 같은 선택은 유지한다.' },
      imageExecution: { type: 'string', enum: ['codex-built-in', 'openai-api'], description: '모델과 실행 경로를 제안. needs_image_choice를 사용자에게 보여준다. API는 별도 과금이며 호스트가 실행한다.' },
      confirmImageChoice: { type: 'string', description: '사용자가 선택한 현재 imageChoice.id. feedback에 원답을 전달한다. 선택은 같은 작품의 다음 컷·회차에도 유지하며 변경 시 다시 확인한다.' },
      preserveReferences: { type: 'boolean', description: '모델 변경 시 승인된 동일 디자인 참조를 재사용한다. 실제 생성 모델·파일 해시·원 승인 이력을 보존하며 새 컷은 새 모델로 요청한다. 사용자 선택에 함께 결합된다. 기본 false.' },
      continuityPlan: { type: 'object', description: '새 제작은 version:2로 단순 러프→사용자 storyboard 승인→본 작화를 진행한다. scenes:[{id,environmentId,layout,cameraAxis}], shots:[{shotId,sceneId,transition:reset|continue|cut,previousShotId?,anchorShotId?,resetReason?,visibleCharacters?,background?:establish|partial|abstract,blocking,camera,before,after,change,decisiveMoment}]. 모든 컷을 읽기 순서로 포함, 연속 묶음당 최대 6컷. continue/cut은 바로 앞 컷 ID, 첫 컷 이후 reset은 실제 시간·장소 전환 사유 필수. cut은 승인 러프 기준 병렬 생성 후 두 그림 연결 검토, continue/anchor는 선행 작화 검토 후 순차 생성. 승인 러프는 실제 첨부. feedback 필수. v1 기존 동작 유지. 자세한 절차는 docs/reference/WEBTOON_WORKFLOW.md.' },
      continuityRoughs: { type: 'array', items: { type: 'object' }, description: '러프 반입: sceneId,inputHash,path,provenance. 현재 러프 job만 실행.' },
      continuityReviews: { type: 'array', items: { type: 'object' }, description: '실제 그림 검토: kind(rough|shot|transition),id,hash,inspectedImages:true,passed:boolean,evidence. v2 rough는 roughReviewJobs의 contextHash, 모든 컷 observations:[{shotId,verdict,evidence}]와 모든 이전 연결 transitions:[{from,to,verdict,evidence}], shot은 composition:{verdict,evidence} 필수. verdict=clear|unclear|contradiction. passed=true는 전부 clear일 때만. transition은 continuity.transitions의 id/hash로 실제 두 그림을 검토. assets와 같은 호출 가능. 호스트 자기보고이며 러프 사용자 승인을 대신하지 않는다.' },
      retry: { type: 'boolean', description: '실패한 조판 분석 모델 요청을 같은 단계에서 재시도한다.' },
      revisionTarget: { type: 'object', properties: { kind: { type: 'string', enum: ['lettering'] }, shotIds: { type: 'array', minItems: 1, items: { type: 'string' } } }, required: ['kind', 'shotIds'], description: '그림·대사를 유지하는 조판만 수정. feedback과 함께 preview에서 사용한다.' },
      references: { type: 'array', description: '호스트가 생성한 참조 이미지 반입. inputHash는 참조 job과 같아야 하며, 참조가 바뀌면 그 참조를 쓴 컷 이미지는 폐기된다.', items: { type: 'object', properties: { referenceId: { type: 'string' }, inputHash: { type: 'string' }, path: { type: 'string' }, provenance: { type: 'object' } }, required: ['referenceId', 'inputHash', 'path'] } },
      assets: { type: 'array', description: '호스트가 생성한 컷 이미지 반입. 같은 shotId는 교체되며 final에서는 룩 승인된 이미지를 바꿀 수 없다.', items: { type: 'object', properties: { shotId: { type: 'string' }, inputHash: { type: 'string', description: '새 웹툰 작업은 현재 생성 요청의 inputHash가 필요하다.' }, path: { type: 'string' }, provenance: { type: 'object' } }, required: ['shotId', 'path'] } },
      regenerateShotIds: { type: 'array', items: { type: 'string' }, description: 'preview 전용. 다시 그릴 컷 id. feedback 필수이며 assets와 함께 쓸 수 없다. 해당 컷과 연속 컷 이미지를 폐기하고 편집 job을 발급한다.' }, feedback: { type: 'string', description: '선택 컷 수정의 구체적 변경 내용. preview에서 수정 요청서를 발급한다.' },
    }, required: ['workId', 'workflowId'] },
  },
  {
    name: 'lore_webtoon_decide',
    annotations: writes({ destructive: true }),
    description: '[deprecated] 진행 중인 컷별 작업 마무리 전용. 현재 웹툰 방향·각색 계획·시각 기준·최종본의 정확한 승인 ID에 답한다. 수정 요청은 같은 작업의 관련 단계로 돌아가고 최종 파일이 바뀌면 과거 승인은 사용할 수 없다. '
      + 'approve는 관문 종류에 따라 프로젝트 webtoon/(profile.md, episodes/, references/)를 쓰거나 덮어쓰고 게시하며, 이어지는 단계가 needs_model을 돌려줄 수 있다. hold는 기록만, reject는 워크플로를 끝내며 이후 작업은 lore_webtoon_scene으로 한다. 사용자 결정을 받은 뒤에만 호출한다.',
    inputSchema: { type: 'object', properties: { ...projectArg,
      workflowId: { type: 'string', description: '대상 컷별 워크플로 id(필수).' }, revision: webtoonRevisionArg,
      approvalId: { type: 'string', description: '현재 상태의 approvalId. revision이 바뀌면 이전 id는 STALE_WEBTOON_APPROVAL로 거부된다.' },
      action: { type: 'string', enum: ['approve', 'request_revision', 'hold', 'reject'], description: 'approve=승인·반영, request_revision=feedback으로 관련 단계 재작업, hold=보류, reject=워크플로 종료.' },
      feedback: { type: 'string', description: 'request_revision에 필수. reject에는 선택이며 기록만 된다.' },
      revisionTarget: { type: 'object', properties: { kind: { type: 'string', enum: ['lettering', 'adaptation', 'storyboard'] }, shotIds: { type: 'array', minItems: 1, items: { type: 'string' } }, sceneIds: { type: 'array', minItems: 1, items: { type: 'string' } } }, required: ['kind'], description: 'lettering은 shotIds의 조판만 수정. adaptation은 계획·러프·시각·최종 승인에서 재각색. storyboard는 러프 승인에서 sceneIds의 구도만 수정(생략하면 모든 러프). 소설과 승인 대사는 유지한다.' },
    }, required: ['workId', 'workflowId', 'approvalId', 'action'] },
  },
];

// Keep the normal agent-facing surface focused on complete workflows. The
// advanced surface preserves low-level primitives for maintenance and tests
// without inviting agents to bypass planning, validation, or commit receipts.
const PUBLIC_TOOL_NAMES = new Set([
  'lore_init',
  'lore_status',
  'lore_configure',
  'lore_style_anchor',
  'lore_sync',
  'lore_create',
  'lore_profile',
  'lore_profile_decide',
  'lore_profile_status',
  'lore_story_plan',
  'lore_story_decide',
  'lore_story_status',
  'lore_writer_skill',
  'lore_writer_decide',
  'lore_writer_status',
  'lore_arc_plan',
  'lore_arc_decide',
  'lore_arc_status',
  'lore_arc_review',
  'lore_snapshot_status',
  'lore_rollback',
  'lore_resume',
  'lore_write',
  'lore_decide',
  'lore_workflow_status',
  'lore_workflow_history',
  'lore_webtoon_plan',
  'lore_webtoon_scene',
  'lore_webtoon_render',
  'lore_webtoon_decide',
]);

const MCP_SURFACE = process.env.VIBELORE_MCP_SURFACE === 'advanced' ? 'advanced' : 'public';
const EXPOSED_TOOLS = MCP_SURFACE === 'advanced'
  ? TOOLS
  : TOOLS.filter((tool) => PUBLIC_TOOL_NAMES.has(tool.name));
const EXPOSED_TOOL_NAMES = new Set(EXPOSED_TOOLS.map((tool) => tool.name));

// -- tool execution ---------------------------------------------------------

function storeFor(args) {
  return new MarkdownStateStore(resolve(args?.project ?? process.cwd()));
}

/**
 * Steps that may want model work run through here. One pass; if anything is
 * pending the run is parked on disk and the host is asked. The deterministic
 * result is returned alongside, because it is genuinely useful on its own --
 * a writer who ignores the model question still gets every lexicon, POV,
 * prosody and structural finding.
 */
async function withRelay(store, toolName, args, answers, run) {
  return runRelayedTool({
    store, toolName, args, answers, run,
    executeTool: execWithProviders,
    providerForTool: providerFor,
  });
}

const PREFLIGHT_TOOLS = new Set(['lore_init', 'lore_check', 'lore_arc_decide', 'lore_profile_decide', 'lore_story_decide', 'lore_writer_decide', 'lore_episode_decide', 'lore_decide', 'lore_create', 'lore_draft', 'lore_revise', 'lore_rewrite', 'lore_next_arc', 'lore_era_research', 'lore_arc_plan', 'lore_arc_review', 'lore_profile', 'lore_story_plan', 'lore_writer_skill', 'lore_episode_plan', 'lore_write', 'lore_commit', 'lore_sync']);

function providerFor(toolName, answers = {}) {
  const baseUrl = process.env.VIBELORE_LOCAL_BASE_URL;
  const model = process.env.VIBELORE_LOCAL_MODEL;
  // 형식만 깨진 JSON 응답은 도구별 단발 실패 대신 한 번 고쳐 받는다(src/provider/json-repair.js).
  if (baseUrl && model) return withJsonRepair(createLocalOpenAIProvider({ baseUrl, model }));
  return withJsonRepair(PREFLIGHT_TOOLS.has(toolName) ? createPreflightRelay(answers) : createHostRelay(answers));
}

function execWithProviders(store, toolName, args, providers) {
  const common = { store, workId: args.workId, providers, retryValidation: args.retryValidation };
  switch (toolName) {
    case 'lore_init':
      return runInit({ ...common, genre: args.genre, povMode: args.povMode, targetChapters: args.targetChapters, worldFacts: args.worldFacts, language: args.language });
    case 'lore_arc_decide': return runArcDecide({ ...common, action: args.action });
    case 'lore_profile_decide': return runStoryProfileDecide({ ...common, action: args.action });
    case 'lore_story_decide': return runStorySpineDecide({ ...common, action: args.action });
    case 'lore_writer_decide': return runWriterSkillDecide({ ...common, action: args.action });
    case 'lore_episode_decide': return runEpisodeDecide({ ...common, chapter: args.chapter, action: args.action });
    case 'lore_decide': return runWorkflowDecide({ ...common, approvalId: args.approvalId, action: args.action, feedback: args.feedback });
    case 'lore_check':
      return runCheck({ ...common, chapter: args.chapter, prose: args.prose, title: args.title, summary: args.summary, castManifestRaw: args.castManifestRaw, issueReceipt: true });
    case 'lore_commit':
      return runCommit({
        ...common, chapter: args.chapter, prose: args.prose,
        title: args.title, summary: args.summary, castManifestRaw: args.castManifestRaw, checkId: args.checkId,
      });
    case 'lore_create':
      return runCreate({ ...common, title: args.title, brief: args.brief, genre: args.genre, povMode: args.povMode, targetChapters: args.targetChapters, chapterWordCount: args.chapterWordCount, language: args.language, length: args.length });
    case 'lore_draft':
      return runDraftTool({ ...common, chapter: args.chapter, plan: args.plan, tension: args.tension, targetChars: args.targetChars, language: args.language, length: args.length });
    case 'lore_revise':
      return runReviseTool({ ...common, chapter: args.chapter, prose: args.prose, violations: args.violations, language: args.language });
    case 'lore_rewrite':
      return runRewriteTool({ ...common, chapter: args.chapter, intent: args.intent, language: args.language });
    case 'lore_next_arc':
      return runNextArc({ ...common, currentArc: args.currentArc });
    case 'lore_era_research':
      return runEraResearchTool({ ...common, chapter: args.chapter, era: args.era, claims: args.claims, maxCalls: args.maxCalls });
    case 'lore_arc_plan':
      return runArcPlan({ ...common, mode: args.mode, episodes: args.episodes, direction: args.direction, feedback: args.feedback });
    case 'lore_arc_review':
      return runStoredArcReview({ ...common, throughChapter: args.throughChapter });
    case 'lore_profile':
      return runStoryProfile({ ...common, brief: args.brief, mode: args.mode, feedback: args.feedback, language: args.language, length: args.length });
    case 'lore_story_plan':
      return runStorySpine({ ...common, mode: args.mode, direction: args.direction, feedback: args.feedback });
    case 'lore_writer_skill':
      return runWriterSkill({ ...common, mode: args.mode, feedback: args.feedback });
    case 'lore_episode_plan':
      return runEpisodePlan({ ...common, chapter: args.chapter, mode: args.mode, direction: args.direction, feedback: args.feedback });
    case 'lore_write':
      return runWriteWorkflow({ ...common, instruction: args.instruction, autonomy: args.autonomy, modelProfile: args.modelProfile, language: args.language });
    case 'lore_sync':
      return runSyncStatus({ ...common, action: args.action, approvalId: args.approvalId });
    default:
      throw new Error(`relay not applicable to ${toolName}`);
  }
}

async function callTool(name, args = {}) {
  const definition = EXPOSED_TOOLS.find((tool) => tool.name === name);
  validateToolInput(definition.inputSchema, args);
  const store = storeFor(args);
  return withProjectLock(store.rootDir, async () => {
    await resumePendingRollback({ store });
    return dispatchTool(store, name, args);
  });
}

async function dispatchTool(store, name, args) {
  if (name === 'lore_webtoon_scene') return runWebtoonSceneTool({ store, args, providers: providerFor(name) });
  if (name.startsWith('lore_webtoon_')) return runWebtoonTool({ store, toolName: name, args, providers: providerFor(name), blockNewPanelWorkflows: true });
  if (args.lane !== undefined && !['prose', 'webtoon'].includes(args.lane)) throw new Error('INVALID_WORKFLOW_LANE');
  if (args.lane === 'webtoon' && ['lore_workflow_status', 'lore_workflow_inspect', 'lore_workflow_history'].includes(name)) {
    return readWebtoonWorkflow({ store, ...args, detail: args.detail ?? (name === 'lore_workflow_status' ? 'summary' : 'full'), history: name === 'lore_workflow_history' });
  }
  switch (name) {
    case 'lore_context':
      return buildContext({ store, workId: args.workId, chapter: args.chapter, scene: args.scene });
    case 'lore_status':
      return runStatus({ store, workId: args.workId });
    case 'lore_configure':
      return runConfigureStatus({ store, workId: args.workId, disabledReviews: args.disabledReviews, disabledDraftSections: args.disabledDraftSections, tracking: args.tracking, customTracking: args.customTracking, mergeRecords: args.mergeRecords });
    case 'lore_style_anchor':
      return runStyleAnchor({ store, workId: args.workId, action: args.action, chapters: args.chapters, reason: args.reason });
    case 'lore_init':
    case 'lore_arc_decide':
    case 'lore_profile_decide':
    case 'lore_story_decide':
    case 'lore_writer_decide':
    case 'lore_episode_decide':
    case 'lore_decide':
    case 'lore_check':
    case 'lore_commit':
    case 'lore_create':
    case 'lore_draft':
    case 'lore_revise':
    case 'lore_rewrite':
    case 'lore_next_arc':
    case 'lore_era_research':
    case 'lore_arc_plan':
    case 'lore_arc_review':
    case 'lore_profile':
    case 'lore_story_plan':
    case 'lore_writer_skill':
    case 'lore_episode_plan':
    case 'lore_write':
    case 'lore_sync': {
      await sweepRuns(store.rootDir).catch(() => {});
      if (args.deterministicOnly) {
        const relay = createHostRelay({});
        return { status: 'ok', deterministicOnly: true, ...(await execWithProviders(store, name, args, relay)) };
      }
      return withRelay(store, name, args, {}, null);
    }
    case 'lore_refold':
      return { status: 'ok', ...(await runRefold({ store, workId: args.workId, fromChapter: args.fromChapter })) };
    case 'lore_snapshot_status':
      return { status: 'ok', snapshots: await listSnapshots({ store }) };
    case 'lore_rollback':
      return { status: 'ok', ...(await rollbackToSnapshot({ store, workId: args.workId, chapter: args.chapter })) };
    case 'lore_arc_status':
      return { status: 'ok', ...(await runArcStatus({ store, workId: args.workId })) };
    case 'lore_profile_status':
      return { status: 'ok', ...(await runStoryProfileStatus({ store, workId: args.workId })) };
    case 'lore_story_status':
      return { status: 'ok', ...(await runStorySpineStatus({ store, workId: args.workId })) };
    case 'lore_writer_status':
      return { status: 'ok', ...(await runWriterSkillStatus({ store, workId: args.workId })) };
    case 'lore_episode_status':
      return { status: 'ok', ...(await runEpisodeStatus({ store, workId: args.workId, chapter: args.chapter })) };
    case 'lore_workflow_status':
      return { status: 'ok', ...(await runWorkflowStatus({ store, workId: args.workId })) };
    case 'lore_workflow_history':
      return { status: 'ok', ...(await runWorkflowHistory({ store, workId: args.workId, workflowId: args.workflowId, limit: args.limit, includeModelExchanges: args.includeModelExchanges })) };
    case 'lore_workflow_inspect':
      return { status: 'ok', ...(await runWorkflowInspect({ store, workId: args.workId, workflowId: args.workflowId, detail: args.detail })) };
    case 'lore_resume': {
      const run = await loadRun(store.rootDir, args.runId);
      if (!run) throw new Error(`runId "${args.runId}" 를 찾을 수 없습니다 (만료됐거나 이미 완료됨).`);
      const merged = { ...run.answers, ...(args.answers ?? {}) };
      if (run.tool === 'lore_webtoon_scene') return runWebtoonSceneTool({ store, args: run.args, run, providers: providerFor(run.tool, merged) });
      if (run.tool.startsWith('lore_webtoon_')) {
        return runWebtoonTool({ store, toolName: run.tool, args: run.args, run, providers: providerFor(run.tool, merged), blockNewPanelWorkflows: true });
      }
      return withRelay(store, run.tool, run.args, merged, run);
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// -- JSON-RPC plumbing ------------------------------------------------------

let negotiatedProtocol = FALLBACK_PROTOCOL;

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function fail(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      negotiatedProtocol = SUPPORTED_PROTOCOLS.has(asked) ? asked : FALLBACK_PROTOCOL;
      return reply(id, {
        protocolVersion: negotiatedProtocol,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          'vibelore 는 소설의 설정 일관성과 집필 순서를 지키는 도구입니다. 기본 집필은 lore_write 하나로 시작하세요. ' +
          '회차 계획, 원본 초고 프롬프트, 의미·논리 검사(최대 3회, 그 사이 수정 최대 2회), 승인과 커밋을 영속 워크플로가 순서대로 실행합니다. ' +
          '웹툰화는 webtoon-discovery-interview 스킬로 장면 경로 입력을 정한 뒤 lore_webtoon_scene으로 제작합니다. lore_webtoon_plan 컷별 경로는 deprecated입니다. needs_model은 lore_resume으로 답합니다. 웹툰 조회는 lane=webtoon을 사용합니다.',
      });
    }
    case 'notifications/initialized':
    case 'initialized':
      return;
    case 'ping':
      return isNotification ? undefined : reply(id, {});
    case 'tools/list':
      return reply(id, { tools: EXPOSED_TOOLS });
    case 'tools/call': {
      const name = params?.name;
      try {
        if (!EXPOSED_TOOL_NAMES.has(name)) {
          throw new Error(`unknown tool on ${MCP_SURFACE} surface: ${name}`);
        }
        const result = await callTool(name, params?.arguments ?? {});
        return reply(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        });
      } catch (err) {
        // A tool that fails is data the agent should reason about, not a
        // protocol error -- isError keeps the conversation going.
        return reply(id, {
          content: [{ type: 'text', text: `${name} 실패: ${err.message}` }],
          isError: true,
        });
      }
    }
    default:
      if (isNotification) return;
      return fail(id, -32601, `method not found: ${method}`);
  }
}

/**
 * Requests are handled one at a time.
 *
 * The protocol permits concurrency, but every mutating tool here writes into
 * one project directory, and two chapters committing at once is a corrupted
 * work rather than a fast one. Serialising also means a host that fires
 * `lore_init` and `lore_context` in the same breath gets the obvious
 * behaviour instead of a race.
 */
let queue = Promise.resolve();

const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_QUEUED_BYTES = 32 * 1024 * 1024;
let frame = '';
let frameBytes = 0;
let discarding = false;
let queuedBytes = 0;
function receive(line) {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); }
  catch { return fail(null, -32700, 'parse error'); }
  const bytes = Buffer.byteLength(line);
  if (queuedBytes + bytes > MAX_QUEUED_BYTES) return fail(null, -32600, 'request queue limit exceeded');
  const batch = Array.isArray(msg) ? msg : [msg];
  if (batch.length === 0 || batch.length > 100) return fail(null, -32600, 'invalid batch size');
  queuedBytes += bytes;
  queue = queue.then(async () => {
    for (const m of batch) {
      if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.method !== 'string') { fail(null, -32600, 'invalid request'); continue; }
      try { await handle(m); }
      catch (error) { if (m.id !== undefined && m.id !== null) fail(m.id, -32603, error.message); }
    }
  }).finally(() => { queuedBytes -= bytes; });
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  const parts = chunk.split('\n');
  for (let i = 0; i < parts.length; i++) {
    if (!discarding) {
      frameBytes += Buffer.byteLength(parts[i]);
      if (frameBytes > MAX_FRAME_BYTES) { frame = ''; discarding = true; fail(null, -32600, 'request size limit exceeded'); }
      else frame += parts[i];
    }
    if (i < parts.length - 1) {
      if (!discarding) receive(frame);
      frame = ''; frameBytes = 0; discarding = false;
    }
  }
});
process.stdin.on('end', () => {
  if (frame && !discarding) receive(frame);
  // Finish queued writes before exiting when the host closes stdin.
  queue.finally(() => { process.exitCode = 0; });
});
