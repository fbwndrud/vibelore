/**
 * ProviderRegistry — resolve a provider and model for a generation request.
 *
 * Hosts pass their selection explicitly. Provider adapters implement the shared
 * interface; generator steps do not need vendor-specific branches.
 */
/**
 * Default in-memory ProviderRegistry impl.
 *
 * `adapters` is optional — callers that wire from env may register lazily.
 * `register()` upserts by `provider` id so the latest adapter wins (useful
 * for tests that swap a real adapter for a fake).
 */
export function createProviderRegistry(adapters) {
    const map = new Map();
    const register = (adapter) => {
        map.set(adapter.provider, adapter);
    };
    if (adapters) {
        for (const a of adapters)
            register(a);
    }
    return {
        register,
        has(provider) {
            return map.has(provider);
        },
        async complete(req) {
            const adapter = map.get(req.model.provider);
            if (!adapter) {
                throw new Error(`provider not registered: ${req.model.provider}`);
            }
            return adapter.complete(req);
        },
    };
}
