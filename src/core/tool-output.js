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
  SHARED_LORE_CONTEXT_BUDGET: '공유 context 문서를 필요한 주제·상태 단위로 나누고 장면에서 필요한 문서/인물/필드만 선택하세요. 필수 정본을 조용히 잘라내지 않습니다.',
  SHARED_LORE_SOURCE_DRIFT: 'lore_universe(action="status")로 손수정 또는 미완료 원문 반영을 확인하세요. 새 손수정은 propose/decide로 채택하고 발행 중단은 recover로 복구하세요.',
  SHARED_LORE_UNRESOLVED: 'lore_bind(action="inspect")에서 필요한 필드·시점을 확인하세요. 미정 값을 채택하거나 scene 단위 검사 capability를 구현한 뒤 다시 연결하세요.',
  SHARED_SCENE_CONTEXT_MISSING: '이 화의 명시적인 세계 시점·장면을 binding.chapters에 추가하고 lore_bind inspect/apply로 연결을 갱신하세요.',
  SHARED_LORE_MIGRATION_REQUIRED: '기존 legacy 원고를 현재 발행 저장소로 이행한 뒤 공유 세계에 연결하세요. 기존 원고를 자동으로 덮어쓰지 않습니다.',
  STALE_WORK_BINDING: 'lore_bind(action="status")에서 현재 작품 HEAD를 확인하고 inspect로 연결과 계획 영향을 다시 검토하세요.',
  LORE_VALUE_CONFLICT: '같은 대상·필드·적용 범위의 서로 다른 단일 값을 정리한 뒤 세계 후보를 다시 제안하세요.',
  LORE_DOCUMENT_MISSING: '값의 evidenceIds와 profile/state의 documentIds가 같은 후보의 실제 원문 문서를 참조하도록 수정하세요.',
  LORE_PROPOSAL_DECIDED: '이미 결정한 세계 후보입니다. 현재 lore_universe status를 확인하고 변경이 필요하면 새 후보를 만드세요.',
  LORE_SOURCE_REMOVAL_REQUIRED: '이 단계는 원문을 자동 삭제하지 않습니다. 이전 원문은 author 전용으로 보존하거나 별도의 제거 이행을 구현하세요.',
  INVALID_LORE_PROJECTION: 'lore_bind의 projection 대상과 공유 필드 타입·cardinality를 맞추세요. 지원하지 않는 Foundation 투영을 등록만으로 실행하지 않습니다.',
  INVALID_LORE_DATA: 'lore_registry의 action별 입력과 tools/list의 definition schema를 확인한 뒤 수정하세요.',
  STALE_LORE_HEAD: 'lore_registry(action="status")로 현재 HEAD를 읽고 search로 중복을 다시 확인한 뒤 새 expectedHead로 등록하세요.',
  DEFINITION_CONFLICT: 'lore_registry(action="search")로 같은 namespace의 key/별칭을 확인하고 기존 정의를 재사용하거나 충돌을 해소하세요.',
  DEFINITION_MIGRATION_REQUIRED: '기존 정의의 의미·타입·소유를 변경하는 제안입니다. 현재 등록 도구는 add-only이므로 영향 검토와 이행 구현이 필요합니다.',
  REQUIRED_CAPABILITY: 'lore_registry(action="status")의 지원 capability를 확인하세요. 미지원 동작은 엔진 구현과 검증 후 사용하세요.',
  LORE_INTEGRITY: '공유 세계 등록부의 HEAD 또는 불변 객체가 손상됐습니다. 파일을 직접 고치지 말고 검증된 백업에서 복구하세요.',
  LORE_UNIVERSE_MISMATCH: 'registryRoot에 저장된 universeId를 확인하고 올바른 공유 세계 경로와 식별자를 사용하세요.',
  LORE_REVISION_NOT_FOUND: 'lore_registry(action="status/search")로 해당 세계의 실제 판본을 확인하세요.',
  INVALID_STORY_SCOPE: 'timeline의 continuityId와 pointIds 순서를 확인하고 유효한 범위·조회 시점을 지정하세요.',
  LORE_OWNERSHIP_CONFLICT: '필드 정의의 owner와 값의 소유 원천을 일치시키세요. 같은 필드를 다른 원천에서 재소유하지 마세요.',
  INVALID_DEFINITION_REFERENCE: '고정된 RegistryRevision에 있는 대상 타입·단위·필드의 정확한 ID와 판본을 사용하세요.',
  INVALID_ENTITY_REFERENCE: '해석 입력의 entities에 실제 대상·참조·관찰자를 정확한 타입 판본과 함께 포함하세요.',
  INVALID_SUBJECT_TYPE: '값의 대상 인물이 필드 subjectTypeIds에 허용된 타입인지 확인하세요.',
  INVALID_FIELD_VALUE: '필드의 타입·enum·참조 대상·숫자 범위·문자 길이 제약에 맞게 값을 수정하세요.',
  WORKING_TREE_DRIFT: 'lore_status로 바뀐 원고·설정 파일을 확인하세요. 작품 연결 복구가 대기 중이면 검토 이후 바뀐 파일을 원래대로 되돌린 뒤 다시 호출하고, 일반 손수정은 lore_sync로 반영하세요.',
  SHARED_SCENE_BOUNDARY_UNRESOLVED: '원고에서 장면 경계를 확정할 수 없습니다. 고정한 장면 순서대로 원고를 다시 쓰거나 binding의 장면 목록을 실제 원고에 맞게 lore_bind inspect/apply로 고치세요. 화 전체에 한 장면 상태를 적용하지 않습니다.',
  STALE_SCENE_MAP: '원고나 제작 잠금이 바뀌어 이전 장면 대응표를 재사용할 수 없습니다. lore_write로 같은 워크플로를 다시 검사하세요.',
  OPERATION_CONFLICT: '이 operationId는 다른 요청에 이미 쓰였습니다. 같은 요청의 재시도면 원래 입력을 그대로, 새 요청이면 새 operationId를 보내세요.',
  STALE_ASSET_CATALOG: 'lore_assets(action="status")로 현재 카탈로그 HEAD를 읽고 후보를 다시 제안하세요.',
  ASSET_NOT_APPROVED: '승인된 카탈로그 판본에 있는 asset·표현 프로필만 고정할 수 있습니다. lore_assets propose/decide로 먼저 승인하세요.',
  EXPRESSION_PROFILE_OWNERSHIP: '표현 프로필에는 화풍·팔레트만 둡니다. 나이·몸·이름 같은 세계 값은 lore_universe로 채택하세요.',
  ASSET_SOURCE_MISSING: 'sourcePath에 실제 PNG/JPEG 파일이 있는지 확인하세요.',
  INVALID_ASSET_FILE: '일반 PNG/JPEG 파일만 반입합니다. 심볼릭 링크·디렉터리·손상 파일은 거부됩니다.',
  STALE_SCENE_SCRIPT: 'lore_scene_script(action="status")로 현재 대본 HEAD와 세계·카탈로그 판본을 확인하고 inspect부터 다시 검토하세요.',
  SCENE_SCRIPT_DRIFT: 'scenes/<scriptId>.md에 채택되지 않은 손수정이 있습니다. 수정 내용을 script에 반영해 inspect/apply로 채택하거나 원래 내용으로 되돌리세요.',
  SCENE_SCRIPT_NOT_FOUND: 'lore_scene_script(action="status")로 채택된 대본 ID를 확인하세요.',
  PRODUCTION_INPUT_MISSING: '봉인된 제작 입력(잠금·asset 바이트)이 없습니다. 백업에서 .vibelore/input-objects를 복구하거나 대본을 다시 채택하세요.',
  SCENE_SOURCE_AMBIGUOUS: 'sourceChapters(소설)와 scriptId(독립 대본) 중 하나만 지정하세요.',
  SCENE_ASSET_NOT_PINNED: '채택한 대본의 cast.assetIds에 있는 asset만 assetId 참조로 쓸 수 있습니다. 필요하면 대본을 다시 inspect/apply하세요.',
  SCENE_PRODUCTION_NOT_RECORDED: '시각 검토를 통과해 completed가 된 새 장면 워크플로만 제작 기록이 있습니다. 이전 워크플로는 기록 없이 유지됩니다.',
  SCENE_PRODUCTION_RECORD_CHANGED: '제작 기록이 워크플로 상태·봉인 입력과 맞지 않습니다. .vibelore 파일을 직접 고치지 말고 백업에서 복구하세요.',
  SCENE_PRODUCTION_INPUT_MISSING: '기록된 참조 또는 장면 이미지 파일이 없습니다. 작품 디렉터리의 .vibelore/webtoon과 input-objects를 백업에서 복구하세요.',
  ASSET_BLOB_MISSING: '카탈로그가 가리키는 이미지 바이트가 세계 디렉터리에 없습니다. 백업에서 .vibelore/shared-lore/assets/blobs를 복구하세요.',
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
