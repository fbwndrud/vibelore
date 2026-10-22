# PR #30 review follow-up

2026-10-23. Starting revision: `52bdc7e53717d87a3dab06fb097f453645e4bbef`.
Scope: validate and address the existing review comment, not a fresh independent whole-branch review.

## Accepted and corrected

- Ambient Google keys: CLI startup now reads a key only after an explicit environment/keychain option. The daemon regression uses a dummy ambient key and a local fake endpoint to verify that an unconfigured worker leaves the queue intact, then explicitly enables generation.
- Render diagnostics: output receipts retain bounded classifications instead of arbitrary exception codes/messages. The regression checks timeout diagnosis, secret-free persistence, durable replay and a successful new-output-ID retry of the same Edition. The existing UI retry already worked; immutable failed IDs are intentionally not overwritten. No automatic retries or speculative timeout increase.
- Portable metadata: three source sanitizers and both validation surfaces share one recursive private-field policy, including credentials, session/fetch fields and source fingerprints. Literal manuscript bytes and prompt/citation prose remain unchanged; key filtering cannot certify arbitrary prose as secret-free.
- Dependency notices: record Studio sharp/libvips, Remotion and React terms in NOTICE, retaining the two identical licensed font copies. They serve the separate checkout component and are not silently relicensed or added to the vibelore npm runtime.
- Owner registration: MCP refuses filesystem registration/rebinding, while existing registered owners can be queried, refreshed and unregistered. Authenticated local UI connection is the explicit user selection flow; trusted in-process hosts retain private locator configuration. The tool schema and docs reflect this boundary.
- Library discovery: expose native status, review, current adoption, local source/derived classification and availability filters. Legacy/unclassified data stays unknown. Current source approval never becomes destination adoption. Image/audio consumption advertises render capability; text/video-clip/structured discovery does not.
- Evaluation claims: new cases explicitly record `evaluationVerification: not_performed`, including Library case DTOs. Declared evaluator IDs and relationships cannot authenticate independent readers.
- Local validation: root test:all and the existing release gate now include Studio, with documented checkout dependencies and bounded media-test concurrency. Metadata checks remain separate.
- Distribution/docs: startup instructions require a Git checkout and dependency installation, not the npm runtime. Document Chrome executable selection, Node/codec requirements and schema-1/2 backup compatibility. Remove environment-specific installation claims and historical completion narratives from user guides.
- Smaller valid observations: share process incarnation checks, preserve original transaction errors if rollback also fails, bound HTTP/MCP event pages, provide safe CLI startup codes and place generated test artifacts in each fixture's temporary directory.

## Findings requiring interpretation

- `unobserved` is a conservative case classification, not a promise of no execution or no stored observations. Keeping actual outputs without claiming artistic quality is valid. Its meaning is now explicit; rejecting all such records would discard honest evidence.
- HTTP owner locator input is the private, explicit local connection DTO already described in the public contract. Raw DB/filesystem handles are not exposed. MCP's model-driven register/rebind path was the actionable gap.
- GitHub CI/CodeQL were deliberately disabled by merged PR #25. The fix strengthens local gates; it does not reinstate an opposing deployment policy.
- Internal root imports are the intended read-only vibelore connector seam. Documentation now says repository component, not independently installable package.
- JSON byte arrays are the existing bounded public wire contract. Binary transport redesign, broad hash-helper extraction, splitting large modules/PR history and new migration backup policy are not justified correctness fixes here. Source-owner readers still never migrate; destination upgrade requires the documented prior backup.

## Verification

Node.js 24.19.0, local installed Studio dependencies. No paid provider or private source work was used.

- `npm run test:all`: exit 0. Engine **1,239/1,239** (3.204 s), MCP **1,024/1,024** (77.587 s), Studio **525/525** (305.766 s): **2,788 total**, no failures/cancellations/skips.
- Final exporter/owner/Library/case follow-up: **47/47**, after correcting a cleanup regression identified in diff inspection. The full Studio run subsequently exercised the owner/export and cycle paths as well.
- Initial targeted regressions reproduced ambient-key use, lost render diagnosis, MCP registration and credential-field acceptance before their fixes; the same four paths passed after correction.
- `npm run check:source`: **925** tracked/unignored paths checked; `git diff --check` passed.
- `npm pack --dry-run --json` plus `validatePack`: **290 files**, required resources/allowlist pass; Studio runtime and development records remain excluded.
- Four-file media stress command: `node --test --test-concurrency=4 studio/test/render.test.js studio/test/character-layers.test.js studio/test/edition.test.js studio/test/timeline-tracks.test.js`. First run **43/44**, failing a short multilayer render with `RENDER_FAILED`, renderer stage and unknown reason. Two instrumented reruns were **44/44** (59.970 s and 50.250 s). Their only diagnostic errors were intentional invalid-WAV/timeout test injections. Temporary instrumentation was removed before the full test run.

The stressed render's root cause remains unconfirmed. No claim is made that removing shared test paths or lowering test concurrency causally fixed it. Default Studio concurrency is now one to bound local resource use; output diagnosis and explicit new-output retry are tested independently. No speculative delayRender timeout increase was introduced.

Prepared on `codex/pr30-review-fixes` for PR #30. The user subsequently requested committing and pushing these changes to the PR branch. This follow-up does not publish a release, submit a review comment or merge the PR.
