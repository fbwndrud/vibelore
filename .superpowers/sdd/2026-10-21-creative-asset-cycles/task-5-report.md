# Task 5 — recorded production cycles and scoped cases

## Result and changed interfaces

Implemented `registerCycleCommands(service)` in `studio/src/engine/asset-cycles.js` and registered it through the existing Studio engine. No new table, workflow runner, provider, evaluation service or approval gate was added. Studio remains schema 2; Library remains schema 1.

- `cycle.record`, aggregate `{kind:'cycle',id}`, payload `{record,actor,reason}`: records purpose, exact previous cycles, selected input uses, actual produced/decision/output/execution references, and optional inert planning/omission/external observation metadata.
- `case.record`, aggregate `{kind:'productionCase',id}`, same payload: records question, exact context/literal input refs, explicitly selected literal input text, actual/fixture/planned trials, scoped observations, optional native decision, unknowns, classification, and omissions/planning/external observations. Prior trial and observation array prefixes cannot be rewritten or removed; new observations append. Immutable events preserve earlier records and their actor/reason.
- `snapshot.cycles` and `snapshot.productionCases` derive current aggregate values. Existing command CAS, atomic event recording and command replay apply unchanged. History labels identify cycle/case recording.
- The existing bounded, read-only Studio owner adapter now discovers and exports cycles, cases, immutable adoption receipts, current job/attempt snapshots, and retained exact job/attempt observations. `Library` queries `find`, `lineage`, `uses`, and `cases` expose qualified exact refs and cross-owner citations. Existing query behavior needed no modification; projection validation now accepts the explicitly selected literal inputs, omissions, planning and external observation fields.

### Record and validation vocabulary

A trial contains `{id,kind,status,inputRefs,producedRefs,decisionRefs,outputRefs,executionRefs,conditions,omissions}`; optional `fixtureEvidence` and `comparisonUnit` are inert explanatory data. `kind` is `actual`, `fixture`, or `planned`; status is `succeeded`, `failed`, `outcome_unknown`, `unobserved`, or `planned`. Plans cannot contain produced/decision/output/execution refs or successful result states. Fixtures cannot claim native executions. Actual successful/failed/unknown states must agree with referenced native evidence; recording changes no native job, attempt, budget or reservation state.

An observation supplies an exact target Ref or content hash, nonempty scope/perspective and evaluator `{id,relationship}`. Relationship is `self`, `independent`, or `unknown`; independent claims require an explicit basis and cannot identify the current recording actor or use `self-review` perspective. This records the supplied relationship; it does not manufacture or independently verify an evaluator. Null scores/unknown rights stay literal unknown values. Supplied numeric measurements require a method and unit. No rankings, artistic scores or perceptions are generated.

Classifications are `accepted-example`, `matched-comparison`, `failed-trial`, and `unobserved`. Accepted examples must bind a real selection/publication decision to the actual trial result, rather than an unrelated adoption. Matched comparisons require at least two actual observed trials, equal retained literal input refs and conditions, an explicit task and known integer budget, and distinct comparison identities. With native execution refs, the default unit is execution: a job and its attempt normalize to the same native attempt identity. Explicit `comparisonUnit:'result'` compares retained result refs, permitting honest local/result variants without claiming separate provider runs. A fixture/plan or one repeated result cannot supply a second actual trial. Failed-trial classification requires definite native failure; an unknown outcome is never relabeled successful or failed.

A failed/pending Edition render receipt is valid scoped context/observation evidence, but is rejected in produced/output positions. Actual Edition output refs require completed native output metadata and the native manifest digest.

## Contract rulings and exact reference handling

The parent approved both narrow rulings before implementation; no Studio-owned Library UUID or broad writer instrumentation was invented.

1. **Local native versus portable Ref.** Studio records local exact refs as `{projectId,recordKind,recordId,revision}` without `ownerId`. The current-project native version must resolve. The registered owner adapter qualifies these refs with its supplied `ownerId` when projecting/exporting. External refs retain the full `OriginRef` and require explicit observed scope metadata. They can be input/context/previous-cycle/observation citations, never local produced/decision/output/execution claims. Recording never opens their owner or assumes foreign adoption.
2. **Observation-time execution retention.** Existing generation request events retain an initial full job, while native progress events retain only attempt ID/job ID/status and mutable rows replace later versions. Recording therefore resolves an exact current native row, an existing full native job event, or an identical previously retained observation. It freezes actual job/attempt rows in private `nativeEvidence` inside the append-only record event, with native identity, exact canonical digest, observed status and observation time. It never changes execution state or invents an old version. A missing unobserved past digest fails; HEAD is never substituted.

| Native kind | Exact revision |
| --- | --- |
| candidate, immutable adoption, reuse import | canonical digest of the actual native value |
| sourcePackage | native sourceDigest |
| edition | native closureDigest |
| editionOutput | native output manifestDigest; failed receipts use their actual native value digest as contextual evidence only |
| reviews/publication, cycle, productionCase | canonical digest of retained native event value |
| job/attempt | canonical digest of exact current row, full native initial job event, or retained actual observation |

`cycleNativeRecords`, `nativeRevision`, `portableCycleRecord`, and `cycleReferences` are shared internal command/owner-adapter seams. The reader uses the already opened bounded read-only database. It never calls openStudio, recovery, schema migration or a second executor. Existing source disclosure and source replacement/drift protections remain in force.

Execution exports redact full request bodies/prompts, private connection details and unselected logs by default. They expose native IDs/status/digests, output hashes and an explicit observation scope; a snapshot is not independent proof of provider completion or payment. Case/cycle exports omit private `nativeEvidence`, retain the selected literal inputs and exact refs, and disclose these omissions. Historical incoming bundle links receive citation-only metadata records when their source bytes/record are not selected; these records explicitly disclaim source/execution verification and cannot become invented local executions or automatic source access. Export still uses the existing bundle count/depth/hash/size limits.

## Behavioral verification and exact execution evidence

All commands ran from `/Users/lyoojk/.codex/worktrees/creative-asset-cycles/vibelore` with host permission and the exact installed Node 24 runtime. No installs, real providers, paid requests, credentials, uploads or canon/real `.vibelore` edits occurred. Tests use actual SQLite/files, encoded PNGs, native imports/derivation/adoption, a real audio Edition output, boundary-injected fake providers, and a boundary-injected failing local renderer.

Focused command (each listed log is the output redirected from this exact command):

```sh
NODE_NO_WARNINGS=1 /Users/lyoojk/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test studio/test/asset-cycles.test.js
```

| Log under /tmp | Result / evidence |
| --- | --- |
| task5-red-initial.log | 0/1; `cycle.record` absent (`UNKNOWN_COMMAND`) |
| task5-green-initial.log | 1/1; actual import → local derive → adoption → next cycle, actor, replay, CAS, history |
| task5-red-cases.log | 1/3; `case.record` absent |
| task5-green-cases.log | 3/3; append-only observations, literal null/unknown, planned/fixture restrictions, exact ref/meaning/project checks, no fake independent review |
| task5-red-export.log | 4/6; missing case projection and retained exact job discovery |
| task5-green-export.log | 6/6; Library cases/uses/lineage, external citations, portable owner qualification, redacted execution export, native unknown outcome unchanged |
| task5-red-acceptance.log | 8/9; an unrelated native adoption wrongly qualified an accepted example |
| task5-green-acceptance.log | 9/9; actual trial-selection binding, actual bundle receipt and real local Edition output, matched conditions and distinct results |
| task5-red-dedup.log | 9/10; native job/attempt aliases wrongly looked like separate comparison executions |
| task5-green-dedup.log | 10/10; exact attempt identity normalization |
| task5-red-failed-output.log | 10/11; failed render receipt wrongly qualified as produced output |
| task5-still-red-failed-output.log | 10/11; a text insertion did not apply to formatted code; no GREEN was claimed |
| task5-focused-final.log | **11/11**, 0 fail/skip; 2961.141459 ms; completed-output guard applied, failed receipt still usable as context |

Full Studio command:

```sh
NODE_NO_WARNINGS=1 /Users/lyoojk/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test studio/test/*.test.js
```

- `/tmp/task5-full-studio.log`: 465/466, one existing `production-e2e.test.js` landscape output failure (`RENDER_FAILED`), 80910.896375 ms. The retained test diagnostic was `Local renderer failure: unclassified Visited "http://localhost:3000/index.html" but got no response.` The full suite overlapped focused work; this is not proof of a concurrency root cause.
- Isolated unchanged command: `NODE_NO_WARNINGS=1 /Users/lyoojk/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test studio/test/production-e2e.test.js > /tmp/task5-isolated-production-e2e.log 2>&1`: **1/1**, 24623.570292 ms.
- `/tmp/task5-full-final.log`: **467/467**, 0 fail/skip, 78239.289875 ms; after execution-alias correction, without concurrent renderer test runs. No renderer, lease/process, retry policy or native execution writer was changed.
- Exact ordering: final full GREEN above preceded the last failed-render-receipt validation slice. That localized Task 5 guard and its new regression were then verified with the final focused **11/11** suite. Per parent instruction no redundant third full run was performed; the full result does not claim to include that eleventh Task 5 test.

Installed optional formatter command:

```sh
/Users/lyoojk/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node /Users/lyoojk/.claude/plugins/cache/mattpocock/mattpocock-skills/1.2.3/node_modules/prettier/bin-prettier.js --write studio/src/engine/asset-cycles.js studio/test/asset-cycles.test.js studio/src/source/export-studio-assets.js
```

Later formatting applied only to the new module/test after the final local regression. `git diff --check` passed.

## Self-review and limitations

Self-review checked native identity/revision meaning, cross-project/external rejection, exact historical retention without HEAD fallback, actor/reason/event preservation, plans/fixtures versus actual execution, matching conditions, null/unknown values, no taste gate/ranking, no automatic adoption, and the read-only source boundary. It found and fixed unrelated adoption binding, same-job/attempt comparison aliases, and failed-output receipts being treated as produced assets, with RED/GREEN evidence above.

The initial existing Remotion no-response failure remains a recorded transient verification concern; isolation and the subsequent full suite passed, and its underlying cause was not established. Full native historical job/attempt versions that were never retained remain deliberately unavailable. External source/evaluator assertions and matched task/condition descriptions are authored observations, not independent verification or proof of complete provider/billing evidence. Library is still metadata-only and acquires no blob, job or canon authority.

## Review fix round 1 — Important I1, exact accepted Edition outputs

Read `task-5-review.md` Important I1. The previous accepted selector only recognized candidate/Edition refs. It rejected a valid actual trial whose sole output was the completed native `editionOutput`; adding a matching Edition ref could also hide a mismatched render. Both behaviors were reproduced before implementation.

The localized fix changes only the case binding module and its behavioral tests:

- A completed `editionOutput` can supply the actual accepted result through its exact native `editionReview` or `editionPublication` decision, without an extra Edition ref.
- Direct native review binding compares render ID, Edition identity, closure digest and output manifest digest. For a publication, the validator follows that publication's native `reviewId` to its uniquely retained immutable review, requiring matching Edition, closure, output manifest and policy binding revision. It does not read a current review aggregate or select an arbitrary newest review. Missing/ambiguous exact retained review evidence fails.
- If actual output refs are supplied, an unrelated output cannot pass by adding a matching containing Edition ref. The precise render identity remains necessary even when two native renders have byte-identical output manifests. Edition-only cases still bind their exact Edition closure; candidate/adoption cases retain the existing behavior.
- The completed-output guard remains in force: failed/pending receipts are context/observation evidence, never produced output or successful trial media. A native review's existing `creator_attested`/`not_performed` semantics are unchanged; accepting the scoped case creates no independent perception claim or new review gate.

Real local audio regressions create one diagnostic-policy Edition, two completed native renders, two distinct native reviews, and a publication explicitly pointing to the first retained review. The positive regression accepts exact output-only trials through the first review and publication even with another review present, and retains valid Edition-only binding. Negative regressions reject another render under the same Edition and identical manifest digest (including an attempted Edition-ref bypass), the wrong native review, an unavailable output digest, and an unavailable review digest. Exact closure identity also pins the native immutable Edition/profile; no cross-profile fallback was added.

Exact command, worktree and host permissions are unchanged:

```sh
NODE_NO_WARNINGS=1 /Users/lyoojk/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test studio/test/asset-cycles.test.js
```

- `/tmp/task5-fix1-red.log`: **11/13**, two meaningful failures: exact output-only acceptance rejected, and wrong render with a matching Edition ref wrongly accepted. 5391.093667 ms.
- `/tmp/task5-fix1-green.log`: **13/13**, 0 fail/skip, 5827.896875 ms. Includes all prior eleven Task 5 tests and both new regressions.
- Installed optional formatter ran only on `studio/src/engine/asset-cycles.js` and `studio/test/asset-cycles.test.js`; `git diff --check` passed.
- No renderer, execution writer, schema, adapter, lease/process check, provider, or shared native review/publication code changed. Per parent instruction this localized Task 5 fix required the focused suite, not another full Studio run. Prior full-suite evidence and its exact ordering remain documented above; no newer full result is claimed.

Self-review checked that publication lookup uses the publication's retained native review ID and matching immutable fields, successful output selection requires both exact render and manifest identity, wrong-render/digest refs fail even for the same Edition, and candidate/Edition-only/failed-output behavior stays covered. No new concerns remain for I1; the earlier transient Remotion diagnostic remains preserved in the original verification record.
