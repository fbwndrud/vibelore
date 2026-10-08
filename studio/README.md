# Lore Studio

A local production workspace for retained manuscripts, multi-character scenes,
imported or generated PNG/WAV candidates, scoped adoption/undo, immutable
Editions, actual MP4/WAV exports and portable project backup/restore.

See [the user guide](../docs/LORE_STUDIO.md) for startup, editing, credentials,
recovery and verification limits. It leaves novel canon and `.vibelore/` untouched.

Requires Node `^22.13.0 || ^24.0.0 || ^26.0.0`. Sharp is pinned to `0.35.5`;
optional Remotion `4.0.534` and React `19.3.0` are lockfile-pinned. Video rendering
uses an existing Chrome and FFmpeg/ffprobe. No automatic browser download.

```sh
npm start --prefix studio -- --project /your/project --project-id p1 --google-key-env STUDIO_NO_KEY
npm run mcp --prefix studio -- --project /your/project --project-id p1 --google-key-env STUDIO_NO_KEY
npm test --prefix studio
```

Leave `STUDIO_NO_KEY` unset for a local import-only workspace. The default CLI
credential name otherwise is `GEMINI_API_KEY`; actual generation requires an
explicitly intended configured credential and application budget.

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
Backup format and DB schema are v1; future versions are rejected, not downgraded.

Tests use temporary real SQLite/files, local dummy endpoints, concurrent services,
child-process crash recovery, actual codecs and short installed-runtime renders.
They do not call paid providers or demonstrate human perception/acting quality.
Retained local demo outputs in `local-demo/` are ignored by Git and remain usable
outside implementation scratch. Historical outputs keep playing; rerender requires
the frozen runtime fingerprint, or a new Edition matching current code.

## Completed validation scope

All eight task review gates are complete. The whole-branch review of
`b3200d3..04ab70f` found three Important integration issues; one fix wave
(`ca451d6`) and one scoped rereview closed all three with no new breakage.
Accepted subscriber reuse now reaches timeline/Edition, the first generated image
has an explicit adoption/shot-use path, and Cast edits keep independent state bindings.
This records the original review and scoped follow-up, not a fresh whole-branch rerun.

The final ten-file covering run passed 143/143; source metadata checked 774 paths.
Earlier Studio 279/279, later authority/recovery scopes, root 872/874 followed by
docs 5/5, and engine 1239/1239 remain separate phases with their original failures
preserved in the [implementation evidence](../docs/research/studio-implementation-evidence-2026-10-09.json).
Actual provider-free restored 57.833-second MP4/WAV outputs are retained; final
changes left renderer fingerprint files and the lockfile unchanged. Live Google
quota/billing, artistic/identity/mask quality, screen-reader use, human listening/
viewing approval and browser-download completion are not established by these checks.
