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
import { validateToolInput } from './core/tool-input.js';
import { withProjectLock } from './core/project-lock.js';

import { MarkdownStateStore } from './store/markdown-store.js';
import { createHostRelay, createPreflightRelay } from './provider/host-relay.js';
import { createLocalOpenAIProvider } from './provider/local-openai.js';
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

const SERVER_INFO = { name: 'vibelore', version: '0.1.0' };
const FALLBACK_PROTOCOL = '2025-06-18';

const projectArg = {
  project: { type: 'string', description: '작품 디렉터리의 절대 경로. 생략하면 서버 실행 디렉터리.' },
  workId: { type: 'string', minLength: 1, maxLength: 120, pattern: '^[A-Za-z0-9_-]+$', description: '작품 식별자 ([A-Za-z0-9_-]).' },
};

const TOOLS = [
  {
    name: 'lore_init',
    description:
      '소설 프로젝트를 만들거나, 이미 있는 디렉터리를 그대로 이어받는다. 이미 작품이 있으면 덮어쓰지 않고 현재 상태를 보고한다. 새 소설을 시작할 때 가장 먼저 호출한다.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        genre: { type: 'string', description: '엔진이 아는 장르 id. 틀리면 목록을 알려준다.' },
        povMode: { type: 'string', description: '예: 3인칭제한, 1인칭' },
        targetChapters: { type: 'number', description: '완결 목표 화수. 아크 위치 계산에 쓰인다.' },
        worldFacts: { type: 'array', items: { type: 'string' }, description: '변하지 않는 세계 사실 5~10개.' },
      },
      required: ['workId', 'genre'],
    },
  },
  {
    name: 'lore_context',
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
    description:
      '초고를 검증한다. 호칭 모순, 시점 이탈, 고정 설정 위반, 문체·운율, 대사 비율, 정보 반복, 민감 표현을 한 번에 훑고 무엇이 어디서 깨졌는지 돌려준다. 커밋 전에 반드시 통과시킨다. 의미 판정을 위해 모델 작업이 필요하면 status=needs_model 과 함께 질문을 돌려주니 lore_resume 로 답을 넘긴다.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        chapter: { type: 'integer', minimum: 1 },
        prose: { type: 'string', description: '검증할 본문 전체.' },
        castManifestRaw: { type: 'string', description: '집필 시 만든 캐스트 매니페스트(선택).' },
        deterministicOnly: { type: 'boolean', description: 'true 면 모델 작업 없이 결정론 검사만 수행.' },
      },
      required: ['workId', 'chapter', 'prose'],
    },
  },
  {
    name: 'lore_commit',
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
    description: '작품이 어디까지 왔는지 — 화수, 다음 화 번호, 등장인물, 세계 사실 수, 미해결 떡밥, 아크 커서.',
    inputSchema: { type: 'object', properties: { ...projectArg }, required: ['workId'] },
  },
  {
    name: 'lore_configure',
    description: '기존 Profile·Identity·WriterSkill을 하나의 v2 NarrativeContract로 컴파일해 현재 통합 설정과 누락 단계를 보여준다.',
    inputSchema: { type: 'object', properties: { ...projectArg }, required: ['workId'] },
  },
  {
    name: 'lore_style_anchor',
    description: '사용자가 좋다고 승인한 정본 1~3화를 작품의 문체 기준으로 고정하거나 현재 기준을 조회한다. 자동으로 최신 화를 기준으로 삼지 않는다.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        action: { type: 'string', enum: ['status', 'approve'], description: 'status=조회, approve=지정 화를 새 정본으로 승인' },
        chapters: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'number' }, description: 'approve할 정본 화 번호 1~3개' },
        reason: { type: 'string', maxLength: 2000, description: '사용자가 이 원고를 선호한 이유. 작품 전체의 새 의무가 아닌 문체 참고로 전달한다.' },
      },
      required: ['workId'],
    },
  },
  {
    name: 'lore_sync',
    description: 'Published HEAD 이후 사람이 수정한 Markdown을 감지한다. 마지막 화는 validate 후 approvalId로 재발행하며, 이전 화와 설계 변경은 영향 분석 없이 자동 적용하지 않는다.',
    inputSchema: { type: 'object', properties: { ...projectArg, action: { type: 'string', enum: ['inspect', 'validate', 'apply'] }, approvalId: { type: 'string' } }, required: ['workId'] },
  },
  {
    name: 'lore_create',
    description: '승인된 StoryProfile과 브리프에서 세계 사실·3~5인 캐스트·추적 엔티티를 생성한다. StoryProfile이 있으면 자유 장르를 안전한 엔진 장르에 매핑한다.',
    inputSchema: {
      type: 'object', properties: {
        ...projectArg, title: { type: 'string' }, brief: { type: 'string' }, genre: { type: 'string' },
        povMode: { type: 'string' }, targetChapters: { type: 'number' }, chapterWordCount: { type: 'number' },
      }, required: ['workId', 'title', 'brief'],
    },
  },
  {
    name: 'lore_profile',
    description: '작품 발견 인터뷰의 브리프를 엔진 장르·독서 계약·읽기 난도(표면 가독성·개념 속도·추론 부담·복잡성 상승)·이야기 동력·시점·문체 지침으로 컴파일한다. review 결과에는 누적된 설계 결정, 질문 이력과 최대 5개의 열린 질문이 포함될 수 있으며, 답변을 feedback으로 넘겨 다음 라운드를 이어간다.',
    inputSchema: {
      type: 'object', properties: {
        ...projectArg, brief: { type: 'string' }, mode: { type: 'string', enum: ['review', 'auto'] },
        feedback: { type: 'string' },
      }, required: ['workId', 'brief'],
    },
  },
  {
    name: 'lore_profile_decide',
    description: '검토 대기 StoryProfile을 승인하거나 거절한다.',
    inputSchema: {
      type: 'object', properties: { ...projectArg, action: { type: 'string', enum: ['approve', 'reject'] } },
      required: ['workId', 'action'],
    },
  },
  {
    name: 'lore_profile_status',
    description: '현재 작품의 StoryProfile과 승인 상태를 확인한다.',
    inputSchema: { type: 'object', properties: { ...projectArg }, required: ['workId'] },
  },
  {
    name: 'lore_story_plan',
    description: '세계·인물과 아크 사이의 작품 전체 StorySpine을 생성하고 인과성·주인공 오류·중간 재해석·최종 선택 비용을 검증한다.',
    inputSchema: { type: 'object', properties: { ...projectArg, mode: { type: 'string', enum: ['review', 'auto'] }, direction: { type: 'string' }, feedback: { type: 'string' } }, required: ['workId'] },
  },
  {
    name: 'lore_story_decide',
    description: '검증을 통과해 pending인 StorySpine을 승인하거나 거절한다.',
    inputSchema: { type: 'object', properties: { ...projectArg, action: { type: 'string', enum: ['approve', 'reject'] } }, required: ['workId', 'action'] },
  },
  {
    name: 'lore_story_status',
    description: '현재 작품 전체 StorySpine과 승인 상태를 확인한다.',
    inputSchema: { type: 'object', properties: { ...projectArg }, required: ['workId'] },
  },
  {
    name: 'lore_writer_skill',
    description: '작품에 맞는 서로 다른 WriterSkill 3개를 만들고 짧은 산문 오디션으로 선택한다. 표면 문체가 아니라 장면 판단·정보 지연·지급·고착 방지를 설계한다.',
    inputSchema: { type: 'object', properties: { ...projectArg, mode: { type: 'string', enum: ['review', 'auto'] }, feedback: { type: 'string' } }, required: ['workId'] },
  },
  {
    name: 'lore_writer_decide',
    description: '오디션을 통과해 pending인 WriterSkill을 승인하거나 거절한다.',
    inputSchema: { type: 'object', properties: { ...projectArg, action: { type: 'string', enum: ['approve', 'reject'] } }, required: ['workId', 'action'] },
  },
  {
    name: 'lore_writer_status',
    description: '선택된 WriterSkill, 후보 오디션과 승인 상태를 확인한다.',
    inputSchema: { type: 'object', properties: { ...projectArg }, required: ['workId'] },
  },
  {
    name: 'lore_draft',
    description: '현재 세계·인물·이전 상태·최근 요약을 바탕으로 다음 화 초고를 생성한다. 결과는 아직 저장하지 않으며 lore_check를 거쳐야 한다.',
    inputSchema: {
      type: 'object', properties: {
        ...projectArg, chapter: { type: 'integer', minimum: 1 }, plan: { type: 'string' }, targetChars: { type: 'number' },
        tension: { type: 'object', properties: { ticking: { type: 'string' }, stake: { type: 'string' }, escalation: { type: 'string' } } },
      }, required: ['workId', 'chapter'],
    },
  },
  {
    name: 'lore_revise',
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
    description: '저장된 한 화를 작가의 의도에 맞춰 전면 다시 쓴 초안을 생성한다. 자동 저장하지 않으며 검사·커밋·재접기가 필요하다.',
    inputSchema: {
      type: 'object', properties: { ...projectArg, chapter: { type: 'integer', minimum: 1 }, intent: { type: 'string' } },
      required: ['workId', 'chapter', 'intent'],
    },
  },
  {
    name: 'lore_next_arc',
    description: '누적 요약·활성 인물·엔티티에서 다음 5~50화 아크의 약속, 무대, 이어갈 인물과 전환 훅을 제안한다.',
    inputSchema: {
      type: 'object', properties: { ...projectArg, currentArc: { type: 'object' } }, required: ['workId'],
    },
  },
  {
    name: 'lore_arc_plan',
    description: '다음 아크의 약속과 3~20개 얇은 회차 비트(사건·압력·전환·다음 상태)를 생성한다. mode=review면 사용자 승인 전까지 pending, mode=auto면 즉시 활성화한다.',
    inputSchema: {
      type: 'object', properties: {
        ...projectArg,
        mode: { type: 'string', enum: ['review', 'auto'], description: 'review=사용자 검토, auto=자동 승인' },
        episodes: { type: 'number', description: '아크 화수 3~20' },
        direction: { type: 'string', description: '사용자가 원하는 아크 방향. 비우면 자율 설계.' },
        feedback: { type: 'string', description: '거절한 계획을 다시 만들 때 반영할 피드백.' },
      }, required: ['workId'],
    },
  },
  {
    name: 'lore_arc_decide',
    description: 'pending 아크 계획을 승인해 활성화하거나 거절한다. 거절 후에는 피드백과 함께 lore_arc_plan을 다시 호출한다.',
    inputSchema: {
      type: 'object', properties: { ...projectArg, action: { type: 'string', enum: ['approve', 'reject'] } },
      required: ['workId', 'action'],
    },
  },
  {
    name: 'lore_arc_status',
    description: '현재 아크 계획, 승인 상태, 다음에 쓸 화의 비트를 확인한다.',
    inputSchema: { type: 'object', properties: { ...projectArg }, required: ['workId'] },
  },
  {
    name: 'lore_arc_review',
    description: '이미 작성된 아크의 5화 단위 체크포인트 또는 종결화까지를 다시 읽고 의미 PatternLedger와 아크 단위 품질 리뷰를 갱신한다.',
    inputSchema: {
      type: 'object', properties: { ...projectArg, throughChapter: { type: 'number', description: '평가 종료 화. 생략하면 현재 아크의 마지막 작성 화.' } },
      required: ['workId'],
    },
  },
  {
    name: 'lore_episode_plan',
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
    description: '검토 대기 EpisodePlan을 승인하거나 거절한다.',
    inputSchema: {
      type: 'object', properties: { ...projectArg, chapter: { type: 'integer', minimum: 1 }, action: { type: 'string', enum: ['approve', 'reject'] } },
      required: ['workId', 'chapter', 'action'],
    },
  },
  {
    name: 'lore_episode_status',
    description: '특정 화의 상세 EpisodePlan과 승인·완료 상태를 확인한다.',
    inputSchema: { type: 'object', properties: { ...projectArg, chapter: { type: 'integer', minimum: 1 } }, required: ['workId', 'chapter'] },
  },
  {
    name: 'lore_refold',
    description: '앞 화를 다시 커밋한 뒤 저장된 모든 화 델타를 순서대로 다시 접어 이후 StoryState를 재계산한다.',
    inputSchema: {
      type: 'object', properties: { ...projectArg, fromChapter: { type: 'integer', minimum: 1 } }, required: ['workId'],
    },
  },
  {
    name: 'lore_snapshot_status',
    description: '커밋 때 자동 생성된 장별 복구 snapshot 목록을 보여준다.',
    inputSchema: { type: 'object', properties: { ...projectArg }, required: ['workId'] },
  },
  {
    name: 'lore_rollback',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    description: '지정 장의 snapshot으로 정본과 상태를 되돌린다. 현재 상태는 rollback-archives에 복구 가능하게 보존한다.',
    inputSchema: { type: 'object', properties: { ...projectArg, chapter: { type: 'integer', minimum: 1 } }, required: ['workId', 'chapter'] },
  },
  {
    name: 'lore_era_research',
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
    description:
      'status=needs_model 로 중단된 작업을 이어받는다. requests 의 각 질문에 답한 텍스트를 answers 에 { id: 답변 } 형태로 넘기면 중단 지점부터 계속한다. 답을 하나도 넘기지 않으면 결정론 결과만으로 마무리한다.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        runId: { type: 'string' },
        answers: { type: 'object', description: '{ 질문 id: 모델이 만든 답변 텍스트 }' },
      },
      required: ['runId'],
    },
  },
  {
    name: 'lore_write',
    description: '다음 화의 계획 확인부터 원본 초고 프롬프트, 의미·논리 검사, 최대 3회 수정, 검사 영수증, 승인·커밋까지 순서대로 실행하는 기본 집필 도구다.',
    inputSchema: {
      type: 'object', properties: {
        ...projectArg,
        instruction: { type: 'string', description: '이번 화에 추가할 작가 지시.' },
        autonomy: { type: 'string', enum: ['guided', 'auto'], description: 'guided=완성 원고 승인 후 커밋, auto=품질 통과 시 자동 커밋.' },
        modelProfile: {
          type: 'object', additionalProperties: false,
          description: '단계별 모델 힌트. 비우면 호스트 기본 모델 하나로 진행한다. 값은 모델 ID 문자열 또는 { provider, modelId, reasoningEffort }. default=기준 모델, light=planning·draft·quality에 쓸 가벼운 모델, identity·planning·draft·quality·final=단계별 명시. 호스트 릴레이에서는 요청마다 힌트로 전달되고, 로컬 모델은 provider "local"일 때만 실제로 바뀐다.',
          properties: Object.fromEntries(['default', 'light', 'identity', 'planning', 'draft', 'quality', 'final'].map((key) => [key, {
            anyOf: [
              { type: 'string', minLength: 1, maxLength: 120 },
              { type: 'object', additionalProperties: false, properties: {
                provider: { type: 'string', maxLength: 40 }, modelId: { type: 'string', maxLength: 120 },
                reasoningEffort: { type: 'string', enum: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
              } },
            ],
          }])),
        },
      }, required: ['workId'],
    },
  },
  {
    name: 'lore_decide',
    description: 'lore_write가 완성한 승인 대기 원고를 승인해 커밋하거나 피드백과 함께 거절한다.',
    inputSchema: {
      type: 'object', properties: {
        ...projectArg, approvalId: { type: 'string' }, action: { type: 'string', enum: ['approve', 'request_revision', 'hold', 'reject'] }, feedback: { type: 'string' },
      }, required: ['workId', 'approvalId', 'action'],
    },
  },
  {
    name: 'lore_workflow_status',
    description: '현재 통합 집필 워크플로의 단계, 시도 횟수, 다음 행동과 품질 결과를 확인한다. 모델 응답 대기 중이면 lore_resume에 사용할 pendingRunId도 반환한다.',
    inputSchema: { type: 'object', properties: { ...projectArg }, required: ['workId'] },
  },
  {
    name: 'lore_workflow_history',
    description: '단계·전체 검토 발견·승인·커밋 이력을 확인한다. includeModelExchanges=true이면 선택된 이벤트의 실제 모델 요청과 응답도 반환한다.',
    inputSchema: { type: 'object', properties: { ...projectArg, workflowId: { type: 'string' }, limit: { type: 'number' }, includeModelExchanges: { type: 'boolean' } }, required: ['workId'] },
  },
  {
    name: 'lore_workflow_inspect',
    description: '특정 또는 현재 워크플로의 안전한 상세 상태와 검사 영수증을 확인한다. 원고 전문과 모델 응답은 노출하지 않는다.',
    inputSchema: { type: 'object', properties: { ...projectArg, workflowId: { type: 'string' } }, required: ['workId'] },
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

const PREFLIGHT_TOOLS = new Set(['lore_create', 'lore_draft', 'lore_revise', 'lore_rewrite', 'lore_next_arc', 'lore_era_research', 'lore_arc_plan', 'lore_arc_review', 'lore_profile', 'lore_story_plan', 'lore_writer_skill', 'lore_episode_plan', 'lore_write', 'lore_commit', 'lore_sync']);

function providerFor(toolName, answers = {}) {
  const baseUrl = process.env.VIBELORE_LOCAL_BASE_URL;
  const model = process.env.VIBELORE_LOCAL_MODEL;
  if (baseUrl && model) return createLocalOpenAIProvider({ baseUrl, model });
  return PREFLIGHT_TOOLS.has(toolName) ? createPreflightRelay(answers) : createHostRelay(answers);
}

function execWithProviders(store, toolName, args, providers) {
  const common = { store, workId: args.workId, providers };
  switch (toolName) {
    case 'lore_check':
      return runCheck({ ...common, chapter: args.chapter, prose: args.prose, castManifestRaw: args.castManifestRaw, issueReceipt: true });
    case 'lore_commit':
      return runCommit({
        ...common, chapter: args.chapter, prose: args.prose,
        title: args.title, summary: args.summary, castManifestRaw: args.castManifestRaw, checkId: args.checkId,
      });
    case 'lore_create':
      return runCreate({ ...common, title: args.title, brief: args.brief, genre: args.genre, povMode: args.povMode, targetChapters: args.targetChapters, chapterWordCount: args.chapterWordCount });
    case 'lore_draft':
      return runDraftTool({ ...common, chapter: args.chapter, plan: args.plan, tension: args.tension, targetChars: args.targetChars });
    case 'lore_revise':
      return runReviseTool({ ...common, chapter: args.chapter, prose: args.prose, violations: args.violations });
    case 'lore_rewrite':
      return runRewriteTool({ ...common, chapter: args.chapter, intent: args.intent });
    case 'lore_next_arc':
      return runNextArc({ ...common, currentArc: args.currentArc });
    case 'lore_era_research':
      return runEraResearchTool({ ...common, chapter: args.chapter, era: args.era, claims: args.claims, maxCalls: args.maxCalls });
    case 'lore_arc_plan':
      return runArcPlan({ ...common, mode: args.mode, episodes: args.episodes, direction: args.direction, feedback: args.feedback });
    case 'lore_arc_review':
      return runStoredArcReview({ ...common, throughChapter: args.throughChapter });
    case 'lore_profile':
      return runStoryProfile({ ...common, brief: args.brief, mode: args.mode, feedback: args.feedback });
    case 'lore_story_plan':
      return runStorySpine({ ...common, mode: args.mode, direction: args.direction, feedback: args.feedback });
    case 'lore_writer_skill':
      return runWriterSkill({ ...common, mode: args.mode, feedback: args.feedback });
    case 'lore_episode_plan':
      return runEpisodePlan({ ...common, chapter: args.chapter, mode: args.mode, direction: args.direction, feedback: args.feedback });
    case 'lore_write':
      return runWriteWorkflow({ ...common, instruction: args.instruction, autonomy: args.autonomy, modelProfile: args.modelProfile });
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
  switch (name) {
    case 'lore_init':
      return runInit({
        store, workId: args.workId, genre: args.genre, povMode: args.povMode,
        targetChapters: args.targetChapters, worldFacts: args.worldFacts,
      });
    case 'lore_context':
      return buildContext({ store, workId: args.workId, chapter: args.chapter, scene: args.scene });
    case 'lore_status':
      return runStatus({ store, workId: args.workId });
    case 'lore_configure':
      return runConfigureStatus({ store, workId: args.workId });
    case 'lore_style_anchor':
      return runStyleAnchor({ store, workId: args.workId, action: args.action, chapters: args.chapters, reason: args.reason });
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
    case 'lore_arc_decide':
      return { status: 'ok', ...(await runArcDecide({ store, workId: args.workId, action: args.action })) };
    case 'lore_arc_status':
      return { status: 'ok', ...(await runArcStatus({ store, workId: args.workId })) };
    case 'lore_profile_decide':
      return { status: 'ok', ...(await runStoryProfileDecide({ store, workId: args.workId, action: args.action })) };
    case 'lore_profile_status':
      return { status: 'ok', ...(await runStoryProfileStatus({ store, workId: args.workId })) };
    case 'lore_story_decide':
      return { status: 'ok', ...(await runStorySpineDecide({ store, workId: args.workId, action: args.action })) };
    case 'lore_story_status':
      return { status: 'ok', ...(await runStorySpineStatus({ store, workId: args.workId })) };
    case 'lore_writer_decide':
      return { status: 'ok', ...(await runWriterSkillDecide({ store, workId: args.workId, action: args.action })) };
    case 'lore_writer_status':
      return { status: 'ok', ...(await runWriterSkillStatus({ store, workId: args.workId })) };
    case 'lore_episode_decide':
      return { status: 'ok', ...(await runEpisodeDecide({ store, workId: args.workId, chapter: args.chapter, action: args.action })) };
    case 'lore_episode_status':
      return { status: 'ok', ...(await runEpisodeStatus({ store, workId: args.workId, chapter: args.chapter })) };
    case 'lore_decide':
      return { status: 'ok', ...(await runWorkflowDecide({ store, workId: args.workId, approvalId: args.approvalId, action: args.action, feedback: args.feedback, providers: createHostRelay({}) })) };
    case 'lore_workflow_status':
      return { status: 'ok', ...(await runWorkflowStatus({ store, workId: args.workId })) };
    case 'lore_workflow_history':
      return { status: 'ok', ...(await runWorkflowHistory({ store, workId: args.workId, workflowId: args.workflowId, limit: args.limit, includeModelExchanges: args.includeModelExchanges })) };
    case 'lore_workflow_inspect':
      return { status: 'ok', ...(await runWorkflowInspect({ store, workId: args.workId, workflowId: args.workflowId })) };
    case 'lore_resume': {
      const run = await loadRun(store.rootDir, args.runId);
      if (!run) throw new Error(`runId "${args.runId}" 를 찾을 수 없습니다 (만료됐거나 이미 완료됨).`);
      const merged = { ...run.answers, ...(args.answers ?? {}) };
      if (Object.keys(args.answers ?? {}).length === 0) {
        // Explicitly declining to answer is a valid choice, not an error.
        const relay = providerFor(run.tool, merged);
        const result = await execWithProviders(store, run.tool, run.args, relay);
        if (!result?.preview) await dropRun(store.rootDir, run.id);
        return { status: 'ok', degraded: true, note: '모델 답변 없이 결정론 결과로 마무리했습니다.', ...result };
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
      negotiatedProtocol = typeof asked === 'string' ? asked : FALLBACK_PROTOCOL;
      return reply(id, {
        protocolVersion: negotiatedProtocol,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          'vibelore 는 소설의 설정 일관성과 집필 순서를 지키는 도구입니다. 기본 집필은 lore_write 하나로 시작하세요. ' +
          '회차 계획, 원본 초고 프롬프트, 의미·논리 검사, 최대 3회 수정, 승인과 커밋을 영속 워크플로가 순서대로 실행합니다.',
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
