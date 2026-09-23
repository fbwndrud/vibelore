import { HOST_EXECUTION_NOTE, layoutRelayRequests } from './core/relay-prompt-layout.js';
import { dropRun, newRunId, saveRun } from './runs.js';

const TERMINAL_WORKFLOW_STAGES = new Set(['completed', 'rejected', 'clean_fail']);

/**
 * Every relayed request is self-contained: the canon, plans and prose it needs
 * are already in `system` and `user`. CLI hosts that spawn a fresh agent per
 * request otherwise try to read project files and hit turn limits.
 */
export { HOST_EXECUTION_NOTE };

/**
 * Owns host-model relay parking/resume. MCP server code should stay a thin
 * adapter: choose a store, dispatch a tool, serialize the result.
 */
export async function runRelayedTool({
  store,
  toolName,
  args,
  answers = {},
  run = null,
  executeTool,
  providerForTool,
}) {
  if (!store || typeof executeTool !== 'function' || typeof providerForTool !== 'function') {
    throw new Error('INVALID_RELAY_RUNNER: store, executeTool, providerForTool are required');
  }

  let effectiveAnswers = answers ?? {};
  if (toolName === 'lore_write') {
    const workflow = await store.loadWorkflow(args.workId);
    effectiveAnswers = { ...(workflow?.relayAnswers ?? {}), ...effectiveAnswers };
  }

  const relay = providerForTool(toolName, effectiveAnswers);
  const result = await executeTool(store, toolName, args, relay);
  const pending = relay.pending ?? [];

  if (toolName === 'lore_write') {
    const workflow = await store.loadWorkflow(args.workId);
    if (workflow) {
      if (pending.length === 0 && TERMINAL_WORKFLOW_STAGES.has(workflow.stage)) {
        delete workflow.relayAnswers;
      } else {
        workflow.relayAnswers = effectiveAnswers;
      }
      if (pending.length === 0) delete workflow.pendingRunId;
      await store.saveWorkflow(args.workId, workflow);
    }
  }

  if (pending.length === 0) {
    if (run) await dropRun(store.rootDir, run.id);
    return { status: 'ok', ...result };
  }

  const saved = await saveRun(store.rootDir, {
    id: run?.id ?? newRunId(),
    tool: toolName,
    args,
    answers: effectiveAnswers,
    createdAt: run?.createdAt ?? new Date().toISOString(),
  });

  if (toolName === 'lore_write') {
    const workflow = await store.loadWorkflow(args.workId);
    if (workflow) {
      workflow.pendingRunId = saved.id;
      await store.saveWorkflow(args.workId, workflow);
    }
  }

  return {
    status: 'needs_model',
    runId: saved.id,
    requests: layoutRelayRequests(pending, relay.sharedContexts ?? []),
    instruction:
      '각 request 의 system 과 user 를 그대로 읽고 답을 만든 뒤, lore_resume 에 { runId, answers: { <request id>: "<답변>" } } 로 넘기세요. ' +
      'jsonMode=true 인 요청은 코드블록 없이 순수 JSON 으로만 답해야 합니다. 답을 넘기지 않으면 아래 결정론 결과가 최종입니다. ' +
      '한 응답의 requests 는 서로 독립이므로 병렬로(서브에이전트·동시 CLI 실행) 답해도 되며, 순서와 무관하게 모든 답을 한 번의 lore_resume 에 함께 넘기세요. ' +
      'promptCache 가 있는 요청들은 system 과 user 의 공통 자료 블록(sharedPrefixEndMarker 까지)이 바이트 단위로 같으므로, 새 프로세스·API 호출로 답한다면 ' +
      'warmFirst=true 인 요청을 먼저 보내 첫 출력이 시작된 뒤 나머지를 병렬로 보내면 프롬프트 캐시를 재사용합니다. ' +
      'Claude Code CLI(claude -p)는 system 과 마지막 user 블록에만 캐시 지점을 두므로 공통 자료 블록을 --system-prompt 의 system 뒤에 붙이고 나머지만 stdin 으로 보내세요.',
    deterministicResult: result,
  };
}
