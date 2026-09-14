/**
 * JSON 모드 요청의 형식 오류를 한 번 고쳐 받는 provider 경계.
 *
 * 2026-09-14 실제 Sonnet 5 표본에서 10~20KB JSON 응답이 닫는 괄호 누락·쉼표 누락으로
 * 단계마다(story-profile, worldbuild, cast-design) 단발 실패했다. 도구는 각자 파싱하므로
 * 모든 도구가 같은 완화를 갖도록 호스트가 넘기는 providers 를 여기서 감싼다.
 *
 * - `jsonMode: true` 요청만 본다. 펜스를 벗긴 뒤 JSON.parse 가 되면 그대로 돌려준다.
 * - 안 되면 이전 응답과 파서 메시지·오류 위치 원문을 붙여 **정확히 `attempts` 번**(기본 1)
 *   같은 step 으로 다시 요청한다. 내용은 고치지 않고 형식만 다시 받는다.
 * - 대기(pending) 상태의 relay 는 건드리지 않는다. 마지막 응답이 여전히 깨져 있으면
 *   그대로 돌려 도구의 기존 오류 경로가 판단한다.
 * - 원본 provider 의 getter(`pending`)·부속 필드는 프로토타입 위임으로 유지된다.
 */
import { describeJsonError, parseJsonCompletion } from '../../engine/src/core/json-completion.js';

export const JSON_REPAIR_STEP_SUFFIX = 'json-repair';

export function jsonRepairMessages(previousText, detail) {
  return [
    { role: 'assistant', content: previousText },
    { role: 'user', content: [
      'The previous answer was not valid JSON and could not be used.',
      `Parser error: ${detail.message}`,
      `Text around the error: «${detail.snippet}»`,
      'Return the same content as exactly one complete JSON object in the required schema: fix the bracket, comma or quoting mismatch at that spot, keep every key, id and value otherwise unchanged, and add no fence, commentary or explanation.',
    ].join('\n') },
  ];
}

export function withJsonRepair(providers, { attempts = 1 } = {}) {
  if (!providers || typeof providers.complete !== 'function' || providers.__jsonRepair) return providers;
  const wrapped = Object.create(providers);
  Object.defineProperty(wrapped, '__jsonRepair', { value: true });
  Object.defineProperty(wrapped, 'repairs', { value: [] });
  Object.defineProperty(wrapped, 'complete', { value: async function complete(request) {
    let response = await providers.complete(request);
    if (!request?.jsonMode || !Array.isArray(request.messages)) return response;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if ((providers.pending?.length ?? 0) > 0) return response;
      const text = String(response?.text ?? '');
      if (parseJsonCompletion(text) !== undefined) return response;
      const detail = describeJsonError(text);
      wrapped.repairs.push({ step: request.step ?? null, attempt, message: detail.message });
      response = await providers.complete({
        ...request,
        messages: [...request.messages, ...jsonRepairMessages(text, detail)],
        jsonRepairAttempt: attempt,
      });
    }
    return response;
  } });
  return wrapped;
}
