# Lore Studio

A local production component of the repository checkout for retained manuscripts, multi-character scenes,
imported or generated PNG/WAV candidates, scoped adoption/undo, immutable
Editions, actual MP4/WAV exports and portable project backup/restore.

See [the user guide](../docs/LORE_STUDIO.md) for startup, editing, credentials,
recovery and verification limits. It leaves novel canon and `.vibelore/` untouched.

Requires Node `^22.13.0 || ^24.0.0 || ^26.0.0`. Sharp is pinned to `0.35.5`;
optional Remotion `4.0.534` and React `19.3.0` are lockfile-pinned. Video rendering
uses an existing Chrome and FFmpeg/ffprobe. No automatic browser download.

```sh
npm ci --prefix studio
npm start --prefix studio -- --project /your/project --project-id p1
npm run mcp --prefix studio -- --project /your/project --project-id p1
npm test --prefix studio
```

Credentials are read only when `--google-key-env NAME` or
`--google-keychain-service SERVICE` is explicitly supplied. Ambient `GEMINI_API_KEY`
is ignored by default; no generation worker starts without an opted-in key.
The vibelore npm package contains documentation, not the Studio runtime. Run these
commands from the Git checkout. Root imports are intentional read-only connector
integration seams; Studio is not an independently installable npm package.
Outside macOS, set `STUDIO_CHROME_PATH` to an installed Chrome executable; it also
overrides the macOS default. FFmpeg and ffprobe must be on PATH.

Production includes an application budget editor. `project.budget.set` uses the
project aggregate revision and command ID, updates the stored project atomically,
and rejects a cap below reserved estimates, unknown holds and settled amounts.
This cap does not pay or verify the provider's bill. Provider failures retain a
safe error code and HTTP status when available; unknown outcomes remain held.

For the existing night-stop fixture, `scripts/google-demo.js` creates a separate
Google production with six distinct prebuilt voices, verbatim Korean transcripts
and speech-metadata acting directions. It uses the normal request/worker/adoption
path, saves receipts, and never retries unknown results automatically. Run with
Node 24 and an explicitly selected local environment file containing
`GOOGLE_API_KEY` (the file and key are never copied into the project):

```sh
node studio/scripts/google-demo.js --project /your/studio-project --assets /your/demo-assets --output /your/google-output --env-file /your/config.env --phase first
# After checking the first persisted operation and decoded WAV:
node studio/scripts/google-demo.js --project /your/studio-project --assets /your/demo-assets --output /your/google-output --env-file /your/config.env --phase complete
```

`--phase first --cue N` generates only that numbered cue (0–11). Repeating an
existing command reuses its result. If a cue is unknown, repair account access
first and use Production's explicit new-attempt action with duplicate-charge
risk acceptance; wait for that attempt to finish before rerunning this script.
The old attempt and hold remain. `complete` renders fresh audio and landscape
Editions only when every selected Google take is ready. Existing local-voice
productions are retained as historical artifacts; they are never a fallback.

## Reusable Library and creative cycles

Start with `--library /your/library` in either HTTP or MCP mode, then explicitly
connect existing owner directories and allowed project IDs in Library. No folders
are scanned or registered automatically. Without this option the interface explains
how to enable Library. MCP can refresh/unregister existing owners; connection and
rebinding require the explicit local UI or trusted in-process host configuration. Search exact old refs, inspect purpose/identity/state mappings,
preserve raw bytes, then separately review/adopt candidates or bind source packages.
The browser queue retains each import command and receipt and retries unfinished
items only. It never rolls back a successful text import because an image fails.

Asset Lab can import independent music/SFX WAVs without speech/casting. The Edit
layer/music panel provides native controls for silent spans, audio timing and
complete multi-character layers, poses, motion and contacts. Existing working and
frozen previews use the same evaluator as actual local MP4/WAV exports.

See [Creative asset cycles](../docs/reference/CREATIVE_ASSET_CYCLES.md) for exact
HTTP/MCP DTOs, migration, validated directory bundle roundtrip, normalization,
role boundaries, and the actual three-cycle fixture. Video/structured discovery and
portable preservation do not imply supported video-clip/structured consumption.
No new provider, automatic generation, publishing or canon write is involved.

## Engine and extensions

`openStudio({directory,providers={},renderer=null})` in `src/engine/index.js`
returns `command(envelope)`, `snapshot(projectId)`, `events(projectId,cursor)`,
`readBlob(projectId,blobId)`, `integrity(projectId)`, `supportBundle(projectId)`,
`collectGarbage(projectId,{graceMs})`, and idempotent `close()`.

Commands require `{projectId,commandId,aggregate:{kind,id},expectedRevision,type,payload}`.
The same complete envelope replays one durable result; reused command ID with a
different envelope or stale aggregate revision fails. Budget is integer USD micros.
Unrelated progress does not advance edit revisions. All final authority is a
synchronous SQLite transaction. `prepare` may await IO under a durable scoped
staging/render lease, with final replay/CAS/reference/fence checks before commit.
`target`, `validate` and `apply` must be synchronous. Trusted extensions must not
start IO or nest write transactions in these callbacks.

`store`, `blobs`, providers, renderer and `registerCommand` are internal extension
interfaces, never transport DTOs. Any extension that stages blobs across awaits
must stay in `service.blobs.leases.scope(kind, callback)` through final reference
commit. Command/background scopes do this automatically. Readers and writers pin
before IO; garbage collection honors durable pins across independent connections.
Unknown attempts and history keep their references regardless of operational age.

Blob publication uses fsynced temporary bytes and an exclusive hard link, then
leaf/root/storage fsync and registry commit. This deliberately requires a local
filesystem supporting hard links. POSIX rename would overwrite an immutable hash
path. DB and filesystem are not one atomic store; startup distinguishes orphans
from registered missing/corrupt bytes and finishes interrupted tombstones safely.

## Portable backup

`project.backup` uses the project aggregate and `{}` payload. Its result contains
`{backupId,archive,projectId,blobCount,digest}`; `archive` is relative to the service
storage directory. `project.restore` uses `{backupId,restoreId}` and creates a fresh
`restores/<restoreId>` directory without switching the running service.

`restoreStudioBackup({archive,directory,providers={},renderer=null})`, exported by
`src/engine/index.js` and `backup.js`, verifies the whole portable directory before
creating the destination and returns an open restored service. It rejects existing
destinations. Restored unfinished execution is inert `outcome_unknown` with
`restore_boundary`; budget stays held. It never assumes copied queued work is unsent.

```sh
node studio/scripts/backup.js backup /your/project p1
node studio/scripts/backup.js restore /your/archive /your/new-project
node studio/scripts/backup.js support /your/project p1 > support.json
```

Project backup is private production content. Default support diagnostics are an
allowlist excluding original text/media, credentials, and absolute source paths.
Backup metadata supports schema 1 and 2; Studio writes DB schema 2 and Library schema 1. Future versions are rejected, not downgraded. Explicitly opening a schema 1 destination with the new engine upgrades it atomically; back up with the old version first. Read-only Library registration never upgrades sources.

Tests use temporary real SQLite/files, local dummy endpoints, concurrent services,
child-process crash recovery, actual codecs and short installed-runtime renders.
They do not call paid providers or demonstrate human perception/acting quality.
Retained local demo outputs in `local-demo/` are ignored by Git and remain usable
outside implementation scratch. Historical outputs keep playing; rerender requires
the frozen runtime fingerprint, or a new Edition matching current code.

## Connect the real family-revenge sample

The opt-in runner captures every numbered chapter, world/character document bytes
and chapter before/after states through the existing read-only vibelore connector.
It then imports the selected episode's final manifest revisions and scene plans,
exactly cited original speech, and existing reference images through public Studio
commands. Source character IDs remain distinct; captions use a separate narrator,
and physical document lettering is retained as provenance rather than speech.

```sh
node studio/scripts/connect-vibelore-sample.js \
  --source-root /your/vibelore/works/family-revenge \
  --project studio/local-demo/real-samples/family-revenge \
  --output studio/local-demo/real-samples/family-revenge/connection \
  --project-id family-revenge
node studio/bin/studio.js \
  --project studio/local-demo/real-samples/family-revenge \
  --project-id family-revenge \
  --vibelore-root /your/vibelore/works/family-revenge \
  --port 55316
```

`--work-id` defaults to the project ID. `--manifest` defaults to
`output/webtoon-ep01/episode-01-manifest.json`, relative to the source root. All
source inputs are read-only; storage/receipt destinations cannot overlap them.
The default six Google prebuilt voice choices and acting direction are scoped to
`family-revenge`. The exported JavaScript function can accept explicit
`voiceIntents` for another work; the CLI does not guess characters from names.
This connection queues no generation, reads no credentials and leaves budget at
zero. Existing image provenance is an import declaration, not a new provider result.

The final four webtoon pages contain 34 original panels. Each page remains one
whole-scene raster shot with lettering baked into it. The cast reference is a
**5인 통합 참조 시트**, reused in five identity slots, rather than five separate
portraits. Scene-tagged image slots use production scope so reference selection
can be saved without immediately invalidating its candidate's scene revision;
each shot and source asset's scene IDs retain the precise scene association.
This permits explicit reuse elsewhere in the production; it does not claim
independent panel crops or editable lettering. Current world documents can include
future changes, while chapter states and scene source paragraphs stay separately
identified.

Final image hashes, revision paths and exact text citations are checked before
project mutation. Successful reruns replay stable commands without overriding
creator changes or adding adoptions. A project-only interruption can resume when
its creation event matches this capture's digest. Changed source is rejected with
`SOURCE_CONNECTION_CHANGED`; connect it to a fresh project/storage directory.
The output `connection-receipt.json` records source/raw/canonical hashes and counts.

## Validation

Run `npm run test:all` from the repository root for engine, MCP and Studio, or
`npm run test:studio` for Studio only. Tests use a concurrency of one to bound local
Chrome/FFmpeg resource use. Real short landscape/portrait renders and decoded WAVs
exercise the frozen output path. These checks do not establish artistic quality,
provider billing or independent-reader evaluation. Historical implementation
records remain under `docs/research`; they do not certify later revisions.
