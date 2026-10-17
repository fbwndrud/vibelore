# Identity and evidence safety implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Fix homonymous identity corruption and add revision-bound evidence/claim/question management.

**Architecture:** Reuse existing immutable world publications and stable IDs. Add pure validation/resolution modules and optional evidence data; keep legacy interpretation pinned.

**Tech Stack:** JavaScript ES modules, Node.js 24, node:test, existing file stores/MCP.

**Spec:** docs/superpowers/specs/2026-10-17-identity-evidence-safety-design.md

## Global Constraints

- No runtime dependency or copied REA code.
- Preserve existing proposal approval, hard/soft policy, disabled reviews, sealed inputs and old delta replay.
- No real manuscripts, runtime state, unrelated primary-checkout changes, merge or release.
- Use Node 24 for verification.

## Review Focus

- Explicit IDs that collide with another record's alias must still identify the ID owner.
- Alias matches spanning multiple definitions must never use first-match selection or search pagination as proof of uniqueness.
- Legacy unmarked delta replay and old lock bytes must remain stable.
- Derived-evidence cycles, repeated quotes and UTF-16 spans must not forge qualification.
- Character beliefs, author-only source docs and proposed claims must not leak into world truth or reader disclosure.

### Task 1: Safe registry reuse and reference resolution

**Files:** engine/src/lore/extend.js; engine/src/core/identity-reference.js (new); engine/src/core/entity-context.js; character resolver consumers; tests.
**Interfaces:** Produces resolveIdentityReference(ref, records, options) -> {status,id?,candidateIds}; consumes existing loreNameKey and compileLoreRegistry.

- [x] Write regressions for changed meaning/same shape, multiple alias matches, exact-ID precedence and ambiguous context/character fallback.
- [x] Run targeted engine/plugin tests; Expected: new behavior assertions FAIL before implementation.
- [x] Implement complete candidate checks, normalized meaning reuse and needs_disambiguation, safe multi-name lookup and surfaced context ambiguity.
- [x] Run focused suites; Expected: all pass, old explicit-ID behavior unchanged.
- [x] Commit implementation and tests.

### Task 2: Versioned ledger identity and lexical duplicate validation

**Files:** engine/src/continuity/ledger.js; story-state.js; continuity-check.js; src/tools/workflow.js; Map-backed lexicons; tests.
**Interfaces:** Consumes identity resolver; produces ledgerIdentityVersion:2 on new extracted deltas and version-aware applyLedgerOps. Unmarked deltas remain v1.

- [x] Write regressions for distinct homonyms in v2, ambiguous update refusal, v1 replay, extraction marker retention and duplicate lexical key rejection.
- [x] Run targeted tests; Expected: newly added assertions FAIL.
- [x] Implement smallest versioned behavior, real extraction/parser wiring and duplicate guards.
- [x] Run ledger, extraction, continuity, workflow and lexicon suites; Expected: all pass.
- [x] Commit implementation and tests.

### Task 3: Validated optional world evidence ledger and pinned MCP lookup

**Files:** engine/src/lore/evidence.js (new); changes.js; src/tools/universe.js; src/server.js; test/world-evidence.test.js (new).
**Interfaces:** Produces validateLoreEvidence(content) and queryLoreEvidence(content, query); consumes existing content documents/values/entities and hashLore. Existing content shape permits only one additional optional evidenceLedger field.

- [x] Write storage/public-MCP regressions for source hash/span validation, source/claim/question refs and cycles, canon-vs-inference/character policy, verified resolution conditions, legacy read and historical pinning after source edit.
- [x] Run tests; Expected: optional ledger rejected or evidence action unsupported.
- [x] Implement strict validation and query helpers, seal through existing world proposal/approval path and expose pinned evidence action.
- [x] Run shared-lore storage/MCP suites and new tests; Expected: pass without altering legacy hashes or gates.
- [x] Commit implementation and tests.

### Task 4: Evidence-bound chapter observations

**Files:** src/core/chapter-observation.js (new); src/tools/commit.js; tests for observation builder and real commit/storage.
**Interfaces:** Produces buildChapterObservation(input), returning existing observation payload plus versioned evidence data; consumes prose, sourceHash, delta.influenceEvents and receipt metadata. Dynamics consumes original influenceEvents unchanged.

- [x] Write regression proving a published report/interpretation does not manufacture established world/reader assertions or numeric belief confidence.
- [x] Run tests; Expected: old blanket metadata assertion FAIL.
- [x] Implement exact-span source evidence and explicitly inferred interpretation/belief records; preserve acceptance and replay input.
- [x] Run commit, dynamics, memory and workflow integration suites; Expected: pass and historical observations untouched.
- [x] Commit implementation and tests.

### Task 5: Documentation, full verification and independent review

**Files:** docs/reference/SHARED_LORE_REGISTRY.md; SHARED_LORE_RUNTIME.md; docs/TOOLS.md; docs/TOOLS.en.md; CHANGELOG.md; research reports and plan/spec.
**Interfaces:** Documents actual public args/outcomes, evidence schema, v1/v2 compatibility and semantic limits.

- [x] Update Korean/English tool references, input schema descriptions and compatibility notes, with synthetic examples and no unsupported completeness claims.
- [ ] Run npm run test:all, npm run check:source, git diff --check and npm pack --dry-run --json using Node 24; Expected: pass and no private/dev state packed.
- [ ] Commit docs and request fresh whole-branch review per superpowers:requesting-code-review using the spec, plan and Review Focus above.
- [ ] Fix Critical/Important review findings RED→GREEN and rerun full checks; Expected: green.
- [ ] Push codex/identity-evidence-safety and open PR against main closing #27 and #28; attach the created PR to this chat.
