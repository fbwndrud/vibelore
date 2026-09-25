/**
 * 모델 완성 텍스트에서 JSON 한 개를 읽는다. 프롬프트가 펜스를 금지해도 실제 모델은
 * ```json ... ``` 로 감싸 돌려주는 일이 있다(2026-09-14 ja worldbuild 표본). 펜스만
 * 벗기고 그 외 복구(쉼표 보정 등)는 하지 않는다 — 형식 오류는 형식 오류로 남는다.
 * @returns {unknown} 해석된 값. 해석 불가면 `undefined`.
 */
export function stripJsonFence(text) {
    let t = String(text ?? '').trim();
    if (t.startsWith('```')) {
        const firstNl = t.indexOf('\n');
        t = firstNl >= 0 ? t.slice(firstNl + 1) : '';
        if (t.trimEnd().endsWith('```'))
            t = t.trimEnd().slice(0, -3);
    }
    return t.trim();
}

export function parseJsonCompletion(text) {
    try {
        return JSON.parse(stripJsonFence(text));
    }
    catch {
        return undefined;
    }
}

/**
 * 파서 메시지와 오류 위치 주변 원문. 수정 재요청이 같은 응답을 되풀이하지 않게 한다.
 * 위치를 알 수 없으면 앞부분을 보인다.
 */
export function describeJsonError(text) {
    const source = stripJsonFence(text);
    try {
        JSON.parse(source);
        return { message: 'not a JSON object', snippet: source.slice(0, 120) };
    }
    catch (error) {
        const message = String(error.message);
        const at = /position (\d+)/.exec(message);
        const index = at ? Number(at[1]) : 0;
        return { message, snippet: source.slice(Math.max(0, index - 120), index + 40) };
    }
}
