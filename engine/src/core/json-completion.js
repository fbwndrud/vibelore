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
