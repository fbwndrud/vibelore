# Changelog

## 0.2.0 — 2026-09-14

Public history restarts from this cleaned tree; see docs/PROVENANCE.md.

- Withdrew the 0.1.0 distribution for a provenance review and re-released after cleanup.
- Removed obsolete external-engine terminology, prior host paths, and unsupported
  originality assertions from implementation comments.
- Replaced identifiable historical character/work fixtures with neutral examples.
- Replaced external-writer-specific leak labels with checks for generic machine annotations.
- Added an optional `modelProfile` to `lore_write`: per-stage model and
  reasoning-effort hints (`default`, `light`, `identity`, `planning`, `draft`,
  `quality`, `final`) surfaced on each `needs_model` request, persisted on the
  workflow, and honored directly by the local provider for `provider: "local"`.
- Redefined the StoryState hook record with vibelore's own field names and
  lifecycle values; snapshots from earlier builds are normalized on load.
- Kept factual source disclosures. Added a source check and a release approval gate;
  successful technical checks do not authorize public redistribution.

## 0.1.0 — 2026-09-13

First public Apache-2.0 release of the local novel-writing MCP server.

- Guided and automatic writing workflows with continuity checks, review evidence,
  human approval, and editable Markdown manuscripts.
- Version-2 recovery snapshots validate identity, file inventory and hashes.
  Rollback publishes a consistent new canonical state, archives stale approvals,
  and resumes interrupted materialization on the next MCP call.
- Validated MCP inputs, bounded input queues, cross-process project locking,
  and a 120-second timeout for optional local model requests.
- Original repetition cues replace the historical imported word lists.
- Node.js 22.13.0+ in the 22.x family and Node.js 24.x support; no dependency
  installation or build step. CI checks Linux, macOS, and Windows.
- Public history excludes private novels, local host settings and experimental
  model transcripts. See docs/PROVENANCE.md and SECURITY.md.

Legacy snapshots without a version-2 manifest require manual migration into a
separate work directory. Network filesystems and multi-tenant hosting are not
supported. Model judgments remain advisory and do not guarantee literary quality.
