/** Public MCP response contracts. Extra fields preserve detailed workflow evidence. */
const text = { type: 'string' };
const nonempty = { type: 'string', minLength: 1 };
const chapter = { type: 'integer', minimum: 1 };
const object = { type: 'object' };
const variant = (status, properties = {}, required = []) => ({
  type: 'object', properties: { status: { type: 'string', enum: [status] }, ...properties },
  required: ['status', ...required],
});

export const ERROR_OUTPUT_SCHEMA = variant('error', {
  code: nonempty, message: text, retryable: { type: 'boolean' }, nextAction: nonempty,
}, ['code', 'message', 'retryable', 'nextAction']);

export const MODEL_OUTPUT_SCHEMA = variant('needs_model', {
  runId: { type: 'string', pattern: '^run-', minLength: 5 },
  requests: { type: 'array', minItems: 1, items: {
    type: 'object', properties: { id: nonempty, step: text, system: text, user: text, jsonMode: { type: 'boolean' },
      promptCache: object }, required: ['id', 'system', 'user'],
  } },
  sharedBlocks: { type: 'array', items: object }, deterministicResult: object, instruction: text,
}, ['runId', 'requests']);

export const WRITE_OUTPUT_SCHEMA = {
  type: 'object', description: '집필 상태별 응답. needs_model은 lore_resume, awaiting_approval은 lore_decide, needs_sync는 lore_sync로 이어간다.',
  anyOf: [
    MODEL_OUTPUT_SCHEMA, ERROR_OUTPUT_SCHEMA,
    variant('awaiting_approval', { workflowId: nonempty, approvalId: nonempty, chapter, prose: text, quality: object },
      ['workflowId', 'approvalId', 'chapter', 'prose']),
    variant('completed', { workflowId: nonempty, chapter, commit: object }, ['workflowId', 'chapter', 'commit']),
    variant('needs_setup', { code: nonempty, chapter, nextAction: nonempty }, ['code', 'chapter', 'nextAction']),
    variant('needs_sync', { code: nonempty, changed: { type: 'array' }, nextAction: nonempty }, ['code', 'nextAction']),
    variant('on_hold', { workflowId: nonempty, chapter }, ['workflowId', 'chapter']),
    ...['clean_fail', 'validation_incomplete', 'provider_error', 'ok'].map(status => variant(status)),
  ],
};

// Resume can complete any original design, prose or webtoon tool. Its non-model
// payload retains that tool's shape rather than pretending every result is prose.
export const RESUME_OUTPUT_SCHEMA = {
  type: 'object', description: 'needs_model은 runId와 requests를 반환한다. 완료 응답은 원래 도구의 설계·집필·웹툰 결과이며 error는 구조화 오류다.',
  anyOf: [MODEL_OUTPUT_SCHEMA, ERROR_OUTPUT_SCHEMA, {
    type: 'object', properties: { status: nonempty }, required: ['status'],
    not: { type: 'object', properties: { status: { enum: ['needs_model', 'error'] } }, required: ['status'] },
  }],
};

const RECOVERY = {
  ARC_IN_PROGRESS: 'lore_arc_status로 활성 아크를 확인하고 lore_write로 계속 쓰세요. 사용자가 교체를 명시적으로 요청한 경우만 lore_arc_plan(replaceActive=true)을 호출하세요.',
  INVALID_ARGUMENT: 'tools/list의 inputSchema에 맞게 입력을 수정한 뒤 다시 호출하세요.',
  UNKNOWN_TOOL: 'tools/list에서 사용 가능한 도구를 확인하세요. 기존 컷별 웹툰 작업은 서버를 VIBELORE_MCP_SURFACE=compat로 다시 시작하세요.',
  RUN_NOT_FOUND: 'lore_workflow_status에서 현재 resume.runId를 확인하세요. 만료된 설계 작업은 원래 도구를 다시 호출하세요.',
  PROJECT_BUSY: '다른 작업이 작품 잠금을 해제한 뒤 같은 호출을 다시 시도하세요.',
};

export function toolFailure(error) {
  const message = String(error?.message ?? error);
  const code = error?.code ?? message.match(/^([A-Z][A-Z0-9_]+)(?=:|$)/)?.[1] ?? 'TOOL_FAILED';
  return { status: 'error', code: String(code), message, retryable: code === 'PROJECT_BUSY',
    nextAction: RECOVERY[code] ?? '오류 원인과 lore_status 또는 lore_workflow_status를 확인한 뒤 필요한 수정 후 다시 호출하세요.' };
}
