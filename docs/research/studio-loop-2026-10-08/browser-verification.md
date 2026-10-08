# Independent prototype verification — round 4

Scope: local interactive design simulation only. This does not verify real image APIs, TTS, rendering, costs, durable storage, or export. The independent checker did not modify the prototype.

## Source observations before browser handoff

Read current prototype source and round-4-critique.md. Builder was concurrently addressing the findings, so these are intermediate observations, not final failures.

1. Late-result stale comparison only included target and prompt, omitting operation/mask/scope.
2. Candidate preserved request scope, while adoption read current scope dropdown. Scope change did not call render, potentially leaving an incorrectly enabled or disabled adoption button.
3. Playback continued selecting utterances while acting fields remained editable.
4. Scores were indexed by occurrence rather than explicit utterance ID.
5. Attempt snapshots were retained in memory but no attempt list was visible.
6. Navigation restored only tab/scene/shot/cast through widget state. Durable production state was explicitly unimplemented.

## Actual browser observations

Executed with the CUA in-app browser against the builder-served local wrapper `http://127.0.0.1:8768/`. Source was reloaded after the scoped-undo update. All actions are local simulations.

| Check | Observed result |
|---|---|
| Independent utterance performance | Set u-s1-1 acting to a unique marker and hold to 1.2s; u-s1-2 retained its own original acting and 0.4s. Returning to u-s1-1 restored marker and 1.2s. |
| Playback edit safety | Started time-table playback; acting, hold, utterance selector and save became disabled. No audio played. |
| Many-cast filter | Expanded to 40 roles. Unassigned filter showed 33: 32 extras plus the initially unassigned ensemble. Scene 2 filter showed four scene roles. |
| Same identity across time | Current Seoyun and child Seoyun both use ch-seoyun, separate role IDs and scene occurrences; child occurrence shown as occ-s2-1 / onscreen / past-child. |
| Voice override inheritance | Saved a child occurrence voice override, changed project default voice, switched back to occurrence scope; override remained. No voice file was produced. |
| Keyboard mask controls | Enter on Hand select and Right nudge produced source rectangle x448,y335,w104,h84. Candidate recipe preserved it. |
| Scoped adoption | Adopted sim-r2 for one shot, then changed adoption scope to project; button correctly reenabled. Child-state common reference proposed exactly one compatible shot, preserving existing pinned shots. |
| Scoped undo | Undo project-reference adoption kept the earlier shot adoption. Undo shot adoption restored r01. A subsequent candidate used sim-r3, without reusing sim-r2. |
| Unknown outcome | Unknown attempt retained original target 1:0 / child slot and original prompt in visible attempt list. No automatic retry or adoption occurred. |
| Late result after navigation and input change | Changed original prompt/mask, navigated to scene 3 and edited another prompt, accepted a simulated late result. It remained tied to original target 1:0 and original hand recipe, visible in Production candidate list. Opening original shot showed stale sim-r4, adoption disabled. |
| Recipe restoration | Restored original prompt and hand mask including 10px nudge; sim-r4 revalidated and adoption enabled. |
| Operation invalidation | Changed operation to Generate. Mask selection/nudge controls disappeared; earlier edit candidate became stale and adoption disabled. |
| Import quarantine | Import example displayed signature/type mismatch quarantine; reason view identified sample-invalid.png and prohibited usable adoption. Explicitly no actual file read. |
| Narrow fit | At outer viewport320x1000, inner root/document width288; root scrollWidth286 and document scrollWidth288. No visible button/input/textarea/select extended beyond root. Cast and Asset Lab screenshots inspected. |
| Desktop fit | At outer viewport1024x1000, inner root/document width992; root scrollWidth990 and document scrollWidth992. Asset Lab screenshot inspected. |
| Runtime logs | Browser error-level console log list empty after the above interactions. |

## Final corrective recheck

Builder changed the residual labels, restarted the local server, and the checker reloaded the final wrapper. Browser observed `작품 연결 흐름 설명 / 자료 가져오기 흐름 설명 / 빈 제작 흐름 설명`, plus explicit notice that these explain designs and preserve the fixture rather than creating/emptying a project. Clicking the empty-flow explanation showed this limitation in Story. Production now said `IMAGE / ATTEMPT HISTORY`. This resolves the misleading state/attempt labels without claiming to implement project creation. Temporary viewport overrides were reset and the checker-created tab closed.

## Remaining UX and implementation limitations

1. The production summary heading still said IMAGE / ATTEMPT 01 and the unknown summary used attempt 01 even with several accurately retained attempt rows. Resolved by the final label recheck above.
2. Choosing `빈 제작에서 시작` only updated Story status in the tested build; returning to Asset Lab showed existing sample artwork/candidates and an enabled candidate-flow control. Start routes are honestly labeled simulations, but this does not demonstrate a genuinely empty asset state. Resolved by explicitly labeling these as explanatory routes; actual new/empty project creation remains outside the prototype.
3. Reload deliberately resets all production edits and attempts; the visible UI warns of this. Only navigation is host-restored. Durable recovery is not verified.
4. Image comparisons are pre-drawn code-native placeholders. No mask pixel preservation or real image model behavior was tested.

## Verification boundary

This is independent browser exercise within architectural loop FOUR. It is not an additional sixth architectural critic loop. No real provider calls, costs, audio quality, lip sync, video rendering, publication, persistence, backup restore, or fault injection were exercised.

