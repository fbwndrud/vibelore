/**
 * Fold entity operations into snapshots and check lifecycle invariants.
 *
 * The host provides the existing snapshots and candidate operations. Validation
 * returns the proposed state without persisting it.
 */
/**
 * lifecycle invariant + register conflict 검사 + ops 분류.
 *
 * - register + 이미 active 동일 entityId → ID 충돌 (HARD).
 * - register + 다른 entityId 인데 같은 canonicalName → alias 충돌 (SOFT WARN,
 *   register 통과; alias 추가는 별 후속).
 * - update + status='destroyed' entity → HARD VIOLATION.
 * - retire + 이미 retired/destroyed → SOFT WARN (idempotent reentry).
 * - retire + active → toRetire (cause='retire'|'destroyed' if explicit).
 */
export function foldEntityOps(input) {
    const toRegister = [];
    const toUpdate = [];
    const toRetire = [];
    const violations = [];
    for (const op of input.ops) {
        switch (op.op) {
            case 'register': {
                const existing = input.byId.get(op.entityId);
                if (existing) {
                    violations.push({
                        severity: 'hard',
                        code: 'ENTITY_ID_CONFLICT',
                        entityId: op.entityId,
                        message: `register attempted on existing entityId "${op.entityId}" (kind=${existing.kind}, name=${existing.canonicalName})`,
                    });
                    break;
                }
                const nameClash = [...input.byId.values()].find((e) => e.canonicalName === op.name && e.status !== 'destroyed' && e.status !== 'retired');
                if (nameClash) {
                    violations.push({
                        severity: 'soft',
                        code: 'ENTITY_NAME_DUPLICATE',
                        entityId: op.entityId,
                        message: `register name "${op.name}" already taken by entity "${nameClash.entityId}" (status=${nameClash.status})`,
                    });
                }
                toRegister.push({ entityId: op.entityId, kind: op.kind, name: op.name });
                break;
            }
            case 'update': {
                const target = input.byId.get(op.entityId);
                if (!target) {
                    violations.push({
                        severity: 'soft',
                        code: 'ENTITY_UPDATE_UNKNOWN',
                        entityId: op.entityId,
                        message: `update target "${op.entityId}" not registered (skip)`,
                    });
                    break;
                }
                if (target.status === 'destroyed') {
                    violations.push({
                        severity: 'hard',
                        code: 'ENTITY_UPDATE_AFTER_DESTROY',
                        entityId: op.entityId,
                        message: `update attempted on destroyed entity "${target.canonicalName}" (${op.entityId})`,
                    });
                    break;
                }
                toUpdate.push({ entityId: op.entityId, fields: op.fields });
                break;
            }
            case 'retire': {
                const target = input.byId.get(op.entityId);
                if (!target) {
                    violations.push({
                        severity: 'soft',
                        code: 'ENTITY_RETIRE_UNKNOWN',
                        entityId: op.entityId,
                        message: `retire target "${op.entityId}" not registered (skip)`,
                    });
                    break;
                }
                if (target.status === 'retired' || target.status === 'destroyed') {
                    violations.push({
                        severity: 'soft',
                        code: 'ENTITY_RETIRE_REENTRY',
                        entityId: op.entityId,
                        message: `retire attempted on already-${target.status} entity "${target.canonicalName}"`,
                    });
                    break;
                }
                toRetire.push({ entityId: op.entityId, cause: op.reason ?? 'retired' });
                break;
            }
        }
    }
    return { toRegister, toUpdate, toRetire, violations };
}
/**
 * 본문 (sanitize.clean) 안에 destroyed entity 의 canonicalName / alias 가
 * 등장하는지 simple substring scan. SOFT violation list 반환.
 *
 * 정밀한 NER 은 별 PR. 본 helper = first-line 검사.
 */
export function scanDestroyedEntityMentions(args) {
    const violations = [];
    for (const e of args.snapshots) {
        if (e.status !== 'destroyed')
            continue;
        const candidates = [e.canonicalName, ...e.aliases];
        for (const name of candidates) {
            if (name.length < 2)
                continue;
            if (args.prose.includes(name)) {
                violations.push({
                    severity: 'soft',
                    code: 'DESTROYED_ENTITY_MENTION',
                    entityId: e.entityId,
                    message: `destroyed entity "${e.canonicalName}" (matched "${name}") mentioned in chapter ${args.chapterNumber}`,
                });
                break; // one violation per entity
            }
        }
    }
    return violations;
}
