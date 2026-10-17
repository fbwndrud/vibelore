# Identity and evidence safety design

2026-10-17. Implements the two improvements authorized after the Korean research report. Issues: #27 and #28. The research report is the approved intent; choices below are implementation decisions, not additional user approvals.

## Intent and constraints

Separate lexical surfaces from identities, and source evidence from interpretation and canon adoption. Preserve the existing Node.js JavaScript/file-based architecture, publication CAS, author proposal approval, sealed inputs, hard/soft policy and disabled reviews. No runtime dependency or copied REA code. Use Node 24 for verification. Work from origin/main in the attached isolated worktree; do not include unrelated dirty primary-checkout files. No manual .vibelore edits and no real manuscripts.

## Identity behavior

Registry ensure reuses only matching normalized meaning and structure. Name matches with different meanings or multiple candidate definitions produce needs_disambiguation with existing candidates; same-ID definition changes continue to require migration. Inspect all name/alias collisions, not only the first search page. Do not automatically add colliding definitions or silently discard new aliases.

Create a reusable reference resolver that prefers exact IDs and otherwise returns zero/one/multiple name candidates. Use it for entity context and character-name fallback; render/propagate ambiguity rather than choosing a first/last match. Existing exact ID paths stay valid. Duplicate seeds in Map-backed lexical dictionaries fail explicitly.

Newly extracted chapter deltas carry ledgerIdentityVersion:2. In v2, register creates a new record even with an existing name; events use exact IDs (unique name fallback may remain readable, ambiguity cannot mutate). Historical deltas without the marker retain v1 replay, including legacy name-based registration. Explicit IDs on new registration must not be silently replaced by a name match. Do not automatically split existing data or rewrite sealed locks.

## Optional world evidence ledger

World content may contain evidenceLedger:{schemaVersion:1,evidence:[],claims:[],questions:[]}; legacy content remains byte-identical and valid. This is a versioned adjunct to the existing adopted values, not a second canon authority. It is sealed within the existing immutable content publication and thus shares CAS/history/locks.

Evidence is {id,basis,documentId,sourceHash,span,quote,dependsOn}. basis is author-decision|text-explicit|rule-derived|model-inferred|character-report. sourceHash uses existing hashLore(document.text). span is null or {from,to} in UTF-16 offsets; non-null span must match the exact nonempty quote and source bytes. author-decision can cite an entire setting document with span:null and quote:null. Other bases require an exact span or derived evidence dependencies as appropriate. Missing sources, duplicate IDs, stale hashes, broken references and cycles are rejected with stable error codes. Classification is not automated entailment proof.

Claims are {id,statement,subjectId,perspective,canonStatus,valueId,evidenceIds,contradictingEvidenceIds,dependsOn}. perspective is {kind:world} or {kind:character,characterId}. canonStatus is proposed|adopted|rejected|superseded. valueId may be null; a non-null valueId must reference an existing matching-subject value, have adopted status and qualifying support, and a character-perspective claim may back only an observer-owned value scoped to that character. A world value cannot be established solely by model inference/character reports. Author decisions and explicit text can qualify; rule-derived evidence needs qualifying dependencies. An adopted value claim cannot have unresolved contradicting evidence. Proposed claims never enter the resolver. All claim references and dependency DAGs are validated.

Questions are {id,question,status,disposition,evidenceIds,contradictingEvidenceIds,resolutionEvidenceIds,dependsOn}. status is open|investigating|blocked|resolved; disposition is null|verified|withdrawn|out-of-scope. Only resolved questions have a disposition. Verified requires qualifying resolution evidence included in support and no unresolved contradiction; withdrawn/out-of-scope are not verified. Open questions do not block writing by themselves. Existing mandatory-value resolver gates remain unchanged. Immutable world revisions retain question history; no separate mutable question store.

Add lore_universe(action:evidence,loreRevisionId,query?) for pinned lookup. query selects one valueId/claimId/questionId or summary; return source revision, relevant evidence/dependencies, claim/question records and explicit legacy-unclassified state when absent. Never mix proposals/current HEAD into a pinned lookup. No automatic world-text or plan rewriting.

## Chapter evidence

Committed observations remain editorially accepted artifacts. Preserve influence events for deterministic CharacterDynamics replay. Add a versioned evidence ledger tying sourceHash/anchor to text-span evidence where exact text exists and explicitly inferred interpretations/relationship beliefs otherwise. Do not manufacture whole-artifact established/revealed assertions or confidence=1. Publication itself does not determine character truth or reader knowledge. Existing accepted observations and their sealed history are not migrated. Test through actual commit/storage boundary as well as pure builder tests.

## Verification and completion

TDD every behavior change. Test v1 replay/v2 homonyms, explicit IDs, multiple aliases, ambiguous names, normalized definition meaning, duplicate lexical seeds, stale evidence/quote spans, support/contradiction/cycle policies, author decisions before revelation, character reports, and pinned historical evidence reads. Exercise public MCP with synthetic worlds. Run both complete engine and plugin suites plus check:source and package dry-run. Fresh independent whole-branch review before PR; fix important findings with regressions. Push only the new feature branch, open PR against main linking both issues; do not merge or publish.

## Builder-check decisions

- Contradicting evidence references block adoption/verification while present; a later immutable revision may remove a resolved reference, and prior revisions preserve its history.
- Rule-derived evidence qualifies only when its nonempty dependency set all recursively qualifies; reject cycles first.
- Existing value.evidenceIds remain document IDs. Claim support/contradiction IDs refer to ledger evidence records. These namespaces are never reinterpreted.

## Implementation clarifications

- Adopted claims cannot depend on proposed claims or incompatible world/character perspectives. Verified questions require resolved dependencies. These guards prevent qualification through unrelated strong evidence.
- Document catalogs return sourceHash for constructing exact evidence without a separate hash-computation tool.
- Chapter source anchors must occur uniquely; repeated/missing anchors remain inferred and report a limitation. Quote presence alone does not prove an interpretation.

## Final review decisions

- v2 custom tracking preserves explicit registration IDs and allocates an automatic custom ID only while unused. Existing custom rules bind by exact ID first; late name attachment is allowed only for a unique record and unique custom candidate whose ID does not own another record. Explicit unregistered custom IDs create that target instead of retargeting another record by name. Current prompt pinning and alias metadata use the same full-ledger uniqueness check. v1 rule interpretation remains unchanged.
- Character claim dependencies require the same characterId and perspective kind. Private belief transfer needs independently represented support.
- Chapter anchors follow the same UTF-16 boundary rule as world evidence; malformed half-surrogates remain inferred with an explicit limitation.
