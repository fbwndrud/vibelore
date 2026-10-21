# Reusable creative asset cycles

Studio preserves selected creative material locally, then records explicit reuse,
adoption, derivation and output decisions. A Library is a discovery index for
explicitly connected owners and projects. It does not own media bytes, generation
jobs, approval decisions or novel canon. There is no genre, style or character-count
preset. Technical compatibility is advisory; artistic quality remains unobserved
unless an actual scoped observation is supplied.

## Start and upgrade deliberately

Use Node 24 and the existing Studio dependencies. Import-only startup:

```sh
node studio/bin/studio.js --project /your/studio-a --project-id p1 --library /your/library --port 4310 --google-key-env STUDIO_NO_KEY
node studio/bin/studio-mcp.js --project /your/studio-a --project-id p1 --library /your/library --google-key-env STUDIO_NO_KEY
```

Leave `STUDIO_NO_KEY` unset. Neither command scans or registers neighboring
folders. In Library, choose `studio` or `vibelore`, an existing owner directory,
and exact allowed project IDs. Separate vibelore work/world roots need separate
registrations. Click refresh to capture observations. Without `--library`, the UI,
bootstrap and MCP initialization explain how to enable it. Reuse of an already
exported bundle remains an engine capability.

Studio writes schema 2 and Library writes schema 1. Stop old executors and make a
backup with the old version before opening an existing Studio destination with
this version. Opening that explicitly selected destination performs the atomic
schema 1→2 upgrade; it preserves aggregates, source bytes, candidates, adoption
history, Editions and command receipts. Old executors reject schema 2. There is
no downgrade. A failed migration rolls back DDL and version. Restore understands
schema 1 and 2 backups and opens a schema 2 destination. Read-only Library owner
adapters never initialize, migrate, recover or modify their sources.

## Library workflow

1. Connect only the intended owner and project scope, then refresh. Search by
   title, media kind, owner, project or role. Details show the complete exact
   `OriginRef`, capabilities, availability and observation time, plus lineage,
   uses and scoped cases. `offline` means connection failure; `missing` requires a
   successful current observation without that exact ref. Replacement/rebinding
   leaves old observations `unverified`. An observation time is not a live promise.
2. Select the exact old revision, then export/prepare inspection. The source
   fingerprint is checked before and after read-only capture/export. No newer
   HEAD substitutes for an unavailable exact revision.
3. For text, supply a title, language and purpose. Preservation creates an
   immutable source package. Use existing **원작·각색** / **제작 관리** actions to
   create a production or deliberately rebase its source afterward.
4. For image/audio, select the advertised role, arbitrary human purpose and an
   existing slot or explicit new scope/subject. When claiming the same character
   or state, map each actual source identity/state to the appropriate local
   identity/state. Whole scenes can map several characters independently.
   Inspection reports missing decisions, unsupported semantics and predicted
   raw/canonical hashes. A normalization change is displayed as an advisory.
5. Add each inspected item to the preservation queue. Text and asset items have
   separate fixed command IDs and saved envelopes. IndexedDB retains their bytes,
   status and receipts. Run/resume sends only unfinished items with the same
   envelopes; successful work is never rolled back because another item fails.
   CAS or stale-pin failures require removing that unfinished queue item,
   reviewing current destination state and making a fresh inspected command.
6. Open each preserved candidate in the existing Asset Lab to review and adopt
   it explicitly. Preservation does not generate, adopt or replace a source
   binding. A queue receipt is not approval of the content.

The queue uses browser storage; clearing site data removes the local queue, not
committed destination receipts or media. Its key combines the opaque, domain-
separated SHA-256 `bootstrap.destinationKey` for the physical Studio destination
with the selected project ID. CLI restarts preserve that key; replacing the store
at the same browser origin/project does not reuse its unfinished commands. Use a
stable local port to revisit the same browser storage origin. Programmatic
`startStudioHttp` callers must inject a stable destinationKey for restart
resumability; omitting it creates a fresh random isolation key per start. Never
use browser storage as a project backup.

## Portable directory bundles

A bundle is a directory containing `manifest.json` and `files/<sha256>`; archives,
symlinks, URLs that instruct fetching, and executable instructions are unsupported.
A supporting browser can save a selected bundle with the directory picker. The
Library panel can load a directory and select a root. The API returns the same
`{bundle,bytes}` representation, where bytes maps hashes to dense integer arrays.
The engine helpers `writeBundleDirectory` and `readBundleDirectory` in
`studio/src/reuse/bundle.js` provide validated local directory roundtrips.

The manifest is schema 1 with an exact canonical digest, opaque native revisions,
required files and explicit runtime/provenance links. Raw selected bytes remain
unchanged. `studio-media-v1` pins destination normalization: JPEG can become PNG,
recording `normalized-from`; existing WAV decoding preserves bytes. Content hash
alone never merges semantic identity or proves artistic equivalence. A selected
root's required/runtime closure is materialized, and its manifest/provenance stays
in immutable Editions, GC roots and backups. Unrelated root files are not imported
as destination blobs. Text preservation currently requires one unambiguous text
root; export separate bundles for multiple text roots.

Limits: manifest 512 KiB; 256 records; 1024 links; 20 MiB per file; 24 MiB unique
files; JSON nesting depth 32. Normal request bodies remain 1 MiB. Only the existing
import channel and reuse inspection accept up to 128 MiB of encoded JSON; decoded
bundle limits still apply. Exported video/structured evidence can be retained as
portable reference material, but Studio video-clip/structured consumption is
explicitly unsupported. No fake renderer, automatic segmentation or provider is
substituted.

## Public transport contract

All HTTP APIs keep the loopback Host, same-origin/Fetch Metadata and bearer-token
defenses. Obtain a token with same-origin `GET /api/bootstrap`. Errors expose a
safe code and generic message, never private owner locators or adapter exceptions.
The Library is injected explicitly into `startStudioHttp`/`serveStudioMcp`.

| HTTP | MCP tool | Body/arguments |
| --- | --- | --- |
| `POST /api/library/commands` | `studio_library_command` | Library envelope / `{request: envelope}` |
| `POST /api/library/query` | `studio_library_query` | Library query / `{request: query}` |
| `POST /api/library/export` | `studio_library_export` | `{ownerId,roots,disclosure}` / `{request: ...}` |
| `POST /api/reuse/inspect` | `studio_reuse_inspect` | `{projectId,bundle,bytes,intent}` / `{request: ...}` |
| `POST /api/import` | `studio_command` | Studio envelope / `{envelope}` |

Library command envelope:
`{commandId,expectedRegistryRevision,type,payload}`. Types are `owner.register`
(`{adapterKind,locator:{directory},allowedProjects}`), `owner.refresh` and
`owner.unregister` (`{ownerId}`), and `owner.rebind`
(`{ownerId,locator,confirmRefs,allowedProjects?}`). Rebind requires explicitly
confirmed exact refs, adapter verification and a fresh generation; copies get new
owner UUIDs. Private locators appear only in these explicit local connection
commands, never find/inspect/export results. Public scope belongs in
`allowedProjects`, not the private locator.

Queries: `find` with optional `text,mediaKind,ownerId,projectId,role,subject,limit`;
`inspect`, `lineage` or `uses` with `ref`; `cases` with optional owner/project.
Every result carries `registryRevision` and public `owners`. Results use
`entries`, `status/entry`, `links`, `uses`, or `cases` respectively. There is no raw
SQL/store/registerCommand transport.

Studio commands retain `{projectId,commandId,aggregate:{kind,id},expectedRevision,
type,payload}` and their existing durable CAS/replay receipts. `source.importBundle`
targets `sourcePackage` with `{bundle,bytes,sourcePackageId,title,language,actor,
reason,productionId?}`; optional productionId is intended-use provenance only.
`asset.importBundle` targets `assetSlot` and accepts `{bundle,bytes,intent,
inspectionDigest,actor,reason}`. Candidate IDs are issued by the destination.

An image/audio intent is `{target:{kind:'assetSlot',id},purpose,identityMap,
stateMap,selections:[{source:OriginRef,slot,role}],mode?}`. `identityMap` entries are
`{source:SubjectRef,destinationIdentityId}` and `stateMap` entries are
`{source:OriginRef,destinationStateId}`. Exactly one selected root/slot is imported
per asset command. `mode` defaults to `reuse-preserved`; explicit `new-import`
creates another candidate. A same command ID with changed payload conflicts.

## Native timing and performance controls

Asset Lab's file import lets a WAV become speech, independent music or SFX. Music
and SFX need neither an utterance nor casting voice; they declare `audioRole` and
still require explicit adoption. In **연출 → 레이어·음악**, edit scene duration,
track selection, start, trim amounts from each end, gain, fades and mute. Scene/
shot slot starts use scene time; production/project slots use production time.
Scene spans are distinct from total production duration. A global music tail can
extend only the final default shot; explicitly authored final timing must cover
that tail. Existing speech fixed/anchor times remain production-global. Empty
additions preserve the old speech schedule.

The same panel edits a complete layer stack with accepted images, onscreen
occurrences, draw order, anchors, translation, positive scale, clockwise radians,
opacity, keyframe rows, pose-switch rows and geometric contact targets. No JSON
writing is required. Baselines accept identity references or actual poses; a pose
cue needs an actual retained pose. Backgrounds accept environment/final-scene
roles; style/edit references stay references. Positions are normalized canvas
translation offsets. Images contain-fit, pose changes preserve anchors, contact
uses target-image fractions, and the existing camera applies once to the composed
stack. Expression/gaze text is descriptive and does not regenerate faces. Saved
working preview and immutable output share the existing frame evaluator.

## Three-cycle example and evidence boundary

The executable acceptance test `studio/test/asset-cycle-e2e.test.js` creates two
real temporary Studio project stores and a published vibelore world fixture:

- Cycle A selects one published state document and approved two-pixel JPEG with
  native identity/state refs, also preserves an independent BOM/CRLF manuscript,
  explicitly maps/normalizes/adopts the image, and freezes/renders an Edition.
- Cycle B selects A's exact accepted pose through Library, maps it to its local
  identity/state, preserves/adopts it, crops an actual one-pixel derivative,
  records an explicitly scoped fixture case with null scores/unknown rights, and
  freezes/renders another Edition.
- Cycle C reexports B's actual derived pose into a new production with changed
  movement and explicitly selected local music. B's MP4 remains a preserved
  reference, not a consumed video clip. It produces real MP4 and WAV outputs.

The test removes A's available owner path, deletes/rebuilds the disposable Library
projection, runs destination GC, backs up/restores B and decodes a fresh render of
its preserved Edition. Source canon hashes and old Edition values remain equal;
imports create no jobs and provider invocation count is zero. These are real local
SQLite/files/codecs/renderers with diagnostic media. They do not measure audience
perception, artistic quality, actual model output or paid provider economics.
Local wall times are measurements, not provider-price claims. Exact verification
results and all implementation rulings are retained in
[the implementation verification note](CREATIVE_ASSET_CYCLES_VERIFICATION.md).
