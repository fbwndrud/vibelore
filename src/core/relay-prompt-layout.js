import { createHash } from 'node:crypto';

/**
 * Relay prompt layout -- how parked requests are presented to the host so that
 * independent requests in one `needs_model` batch share a long, byte-identical
 * prefix that prompt caches can reuse.
 *
 * Prompt caches match prefixes: any byte that differs ends the reusable part.
 * The engine builds each step as `system = role`, `user = step data`, so seven
 * reviews of one chapter share almost nothing up front even though every one
 * carries the same prose. The layout moves only the material every member
 * already has into a shared block and pushes the role and step data behind it:
 *
 *   system  HOST_EXECUTION_NOTE                       identical for everyone
 *   user    [공통 자료 시작 …] label + text [공통 자료 끝 …]   identical within a group
 *           [이번 요청 역할] original system
 *           [이번 요청 자료] original user, shared text replaced by a pointer
 *
 * Only text a workflow declared with `shareContext` and that occurs exactly once
 * in the user of two or more requests is moved, so no request gains material it
 * did not have (an editorial review that excludes the plan stays without it).
 * Request ids stay the fingerprints of the engine's original requests, so
 * answers resume exactly as before; direct providers never see this layout.
 */
export const HOST_EXECUTION_NOTE = '[실행 조건] 이 요청은 자기완결이다. 파일 읽기·검색·도구 실행 없이 위 system과 user에 제공된 자료만으로 단일 최종 응답을 만든다.';
export const JSON_EXECUTION_NOTE = '코드블록 없이 JSON 객체 하나만 출력한다.';
export const PROMPT_LAYOUT_VERSION = 'shared-prefix-v1';

/**
 * Warm-first only pays when the shared prefix clears the cache minimum. Claude
 * Opus 5 / Opus 5.5 cache from 512 tokens, Sonnet 5 / Opus 4.8 from 1024
 * (platform prompt-caching docs); 1024 covers both. Opus 4.6 and Haiku 4.5
 * need 4096, so a chapter-sized block may not cache there.
 */
export const MIN_SHARED_PREFIX_TOKENS = 1024;

const sha = (value) => createHash('sha256').update(value).digest('hex');

/**
 * Lower-bound token estimate without a tokenizer: a Hangul syllable is at least
 * one token (measured ~1.1 on Opus 5.5), other text at least one per 4 chars.
 */
export function estimateTokensLowerBound(text) {
  const value = String(text ?? '');
  const hangul = value.match(/[가-힣]/g)?.length ?? 0;
  return hangul + Math.ceil((value.length - hangul) / 4);
}

function occurrences(haystack, needle) {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) count += 1;
  return count;
}

function withExecutionNote(request) {
  const note = request.jsonMode ? `${HOST_EXECUTION_NOTE} ${JSON_EXECUTION_NOTE}` : HOST_EXECUTION_NOTE;
  return { ...request, system: `${request.system ?? ''}\n\n${note}` };
}

function sharedBlock(context, digest) {
  return `[공통 자료 시작 · ${context.id} · sha256:${digest.slice(0, 16)}]\n`
    + `## ${context.label}\n${context.text}\n`
    + `[공통 자료 끝 · ${context.id}]\n\n`;
}

function groupedRequest(request, context, block, pointer) {
  const at = request.user.indexOf(context.text);
  const stepUser = `${request.user.slice(0, at)}${pointer}${request.user.slice(at + context.text.length)}`;
  const tail = request.jsonMode ? `\n\n${JSON_EXECUTION_NOTE}` : '';
  return {
    ...request,
    system: HOST_EXECUTION_NOTE,
    user: `${block}[이번 요청 역할]\n${request.system ?? ''}\n\n[이번 요청 자료]\n${stepUser}${tail}`,
  };
}

/**
 * @param {Array<{id:string, step:string, jsonMode?:boolean, system:string, user:string}>} requests
 * @param {Array<{id:string, label:string, text:string}>} sharedContexts  declaration order decides ties
 */
export function layoutRelayRequests(requests, sharedContexts = []) {
  const assigned = new Map();
  for (const context of sharedContexts) {
    if (!context?.text) continue;
    const members = requests.filter((request) => !assigned.has(request.id)
      && typeof request.user === 'string' && occurrences(request.user, context.text) === 1);
    if (members.length < 2) continue;
    for (const request of members) assigned.set(request.id, context);
  }

  const groups = new Map();
  return requests.map((request) => {
    const context = assigned.get(request.id);
    if (!context) return withExecutionNote(request);
    const digest = sha(context.text);
    let group = groups.get(context);
    if (!group) {
      const block = sharedBlock(context, digest);
      const size = [...assigned.values()].filter((item) => item === context).length;
      const estimatedTokens = estimateTokensLowerBound(block);
      group = {
        block,
        pointer: `(위 [공통 자료 · ${context.id}]의 「${context.label}」 전문)`,
        hint: {
          layout: PROMPT_LAYOUT_VERSION,
          sharedPrefixId: `sha256:${sha(`${HOST_EXECUTION_NOTE}\u0000${block}`)}`,
          sharedPrefixEndMarker: `[공통 자료 끝 · ${context.id}]\n\n`,
          sharedPrefixChars: block.length,
          estimatedSharedTokens: estimatedTokens,
          groupSize: size,
        },
        warm: estimatedTokens >= MIN_SHARED_PREFIX_TOKENS,
        first: true,
      };
      groups.set(context, group);
    }
    const promptCache = { ...group.hint, warmFirst: group.warm && group.first };
    group.first = false;
    return { ...groupedRequest(request, context, group.block, group.pointer), promptCache };
  });
}
