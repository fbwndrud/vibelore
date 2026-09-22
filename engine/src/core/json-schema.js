/**
 * JSON Schema helpers for structured model responses.
 *
 * Object schemas explicitly close additional properties for providers that require
 * strict JSON output. The implementation is shared by the local provider adapter.
 */
/**
 * OpenAI Structured Outputs (strict) 요구사항:
 *   - 모든 object 에 additionalProperties: false
 *   - strict 모드는 required 가 모든 property 키를 포함해야 함
 * 재귀 적용.
 */
export function addAdditionalProperties(schema) {
    const out = { ...schema };
    if (out.type === 'object') {
        out.additionalProperties = false;
        if (out.properties && typeof out.properties === 'object') {
            const props = {};
            for (const [key, val] of Object.entries(out.properties)) {
                props[key] =
                    val && typeof val === 'object'
                        ? addAdditionalProperties(val)
                        : val;
            }
            out.properties = props;
            out.required = Object.keys(props);
        }
    }
    if (out.items && typeof out.items === 'object') {
        out.items = addAdditionalProperties(out.items);
    }
    return out;
}
