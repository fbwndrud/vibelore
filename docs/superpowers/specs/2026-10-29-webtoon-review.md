# Webtoon visual review

The user requires GPT-6.1 Terra to inspect generated webtoon images and asks for improvements to the actual review prompt. Earlier same-host reviews missed an impossible mirror reflection and merged mirror/case/hand geometry.

Persist a per-work reviewer model through `lore_configure`. Model choice is a host execution hint, not proof of execution; the host must actually delegate to the selected model. Do not change novel or image model selection. Keep old pending requests valid until the caller explicitly requests re-review of the preserved image. Re-review must never issue a drawing job or consume a redraw budget.

New reviews require panel-specific observations for reflection geometry, prop structure/support, hands/contact, within-scene continuity, and layout/timing. Checks allow passed, failed, uncertain, or not_applicable. Uncertainty about a required relation cannot pass. Ordinary omitted/offscreen details that are not required can be not_applicable with a reason. Compare actual images, not intended drawing instructions. Attach the identity/setting references available to the scene. Keep taste advisory. Preserve original receipts and actual request IDs.

Apply the improved review and selected reviewer to the existing first-scene image. Show the candidate and Terra's verdict honestly; no automatic additional paid generation, episode continuation, or novel changes. All verification is local; no GitHub Actions.
