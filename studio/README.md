# Lore Studio storage engine

Lore Studio is an independent, private ESM package. It does not modify the
novel canon, `.vibelore/`, the original MCP server, or the engine package.
Node.js `^22.13.0 || ^24.0.0 || ^26.0.0` is supported. The storage foundation
uses `node:sqlite`, `node:crypto`, and real filesystem I/O.

Run `npm test --prefix studio` from the repository root. `npm start --prefix
studio` and `npm run mcp --prefix studio` target `bin/studio.js` and
`bin/studio-mcp.js`; those entry points belong to the later transport tasks.
Sharp is pinned at `0.35.5`. The optional renderer dependencies are pinned at
Remotion `4.0.534` and React `19.3.0` in this package's lockfile. This storage
engine loads neither codecs nor renderer dependencies and downloads no browser.

## Service contract

```js
import { openStudio } from './src/engine/index.js';

const service = await openStudio({ directory: '/local/studio-projects' });
try {
  await service.command({
    projectId: 'p1', commandId: 'create-p1',
    aggregate: { kind: 'project', id: 'p1' }, expectedRevision: 0,
    type: 'project.create',
    payload: { title: '작품', language: 'ko', budgetMicros: 1000000 },
  });
  await service.command({
    projectId: 'p1', commandId: 'create-main',
    aggregate: { kind: 'production', id: 'main' }, expectedRevision: 0,
    type: 'production.create',
    payload: { id: 'main', title: '본편', sourcePackageId: null },
  });
  console.log(await service.snapshot('p1'));
} finally {
  await service.close();
}
```

`openStudio({ directory, providers = {}, renderer = null })` returns:

- `command(envelope)` → `{ commandId, aggregateRevision, eventCursor, value, replayed }`.
- `snapshot(projectId)` → `{ project, productions, aggregates, eventCursor }`.
  Aggregates contain `{ kind, id, revision, value }`.
- `events(projectId, afterCursor = 0)` → ordered project events containing
  `{ cursor, projectId, commandId, aggregate, aggregateRevision, type, value }`.
- `readBlob(projectId, blobId)` → a verified `Uint8Array`.
- `close()` → idempotent shutdown that waits for accepted blob operations.
  Subsequent public operations reject with `STUDIO_CLOSED`.

Stable IDs match `/^[A-Za-z0-9_-]{1,120}$/`; blob IDs are lowercase SHA-256
hexadecimal digests. Budget amounts are nonnegative safe-integer USD micros.
Commands use canonical JSON: recursively sorted object keys, finite numbers,
plain objects and dense arrays. Unsupported JSON, cycles, accessors, and
prototype keys are rejected before invoking a handler. Own hidden and symbol
properties are rejected; arrays permit only their standard non-enumerable length
property and serialize validated index descriptors without calling input methods.

A missing aggregate starts at revision `0`. Each successful command advances
only its targeted aggregate. A stale revision yields `REVISION_CONFLICT`.
The command target must match the envelope aggregate, preventing callers from
choosing another aggregate to evade CAS. A second project create yields
`PROJECT_EXISTS`. Non-null `sourcePackageId` must identify a `sourcePackage`
aggregate in the same project; source-package creation belongs to the next task.

Command IDs are project scoped. Replay requires the same **entire envelope**,
including `expectedRevision`; keep the original envelope when retrying. Changing
any envelope content under the same ID yields `COMMAND_CONFLICT`. Replay is
checked before CAS and emits no additional event. Event cursors are globally
monotonic; project event streams can therefore have gaps. A failed transaction
persists neither domain changes, command records, aggregate revisions nor events.

Public failures expose `code`, a safe `message`, and safe `details`.
Unexpected command errors become `COMMAND_FAILED`, SQLite errors become
`STORAGE_FAILED`, and blob I/O errors become `BLOB_WRITE_FAILED` or
`BLOB_READ_FAILED`. Allowlisted filesystem error codes appear only as
`details.reason`; paths, SQL text and thrown prompt contents are omitted.

## Internal extension seam

The local engine instance exposes `store`, `blobs`, `providers`, `renderer`, and
`registerCommand(type, handler)` for subsequent engine modules. These are trusted
internal collaborators, not transport DTOs: UI/MCP must send only service results
and never serialize the service or expose provider configuration/storage paths.

Register a command once per open service:

```js
service.registerCommand('production.rename', {
  target: ({ envelope }) => ({ kind: 'production', id: envelope.payload.id }),
  validate({ store, envelope, aggregate }) {
    // Validate payload and project-scoped references before any domain mutation.
    // Throw StudioError on expected failures.
  },
  apply({ store, envelope, aggregate }) {
    store.run('UPDATE productions SET title = ? WHERE project_id = ? AND id = ?',
      envelope.payload.title, envelope.projectId, envelope.payload.id);
    return { ...aggregate.value, title: envelope.payload.title };
  },
});
```

`target(context)` and `apply(context)` are required; `validate(context)` is
optional. All receive `{ store, envelope, aggregate }`, where `aggregate` is the
persisted pre-command `{ kind, id, revision, value }`. `target` must derive the
actual subject independently of the caller's aggregate. The service checks target
ownership and project existence, then CAS, validation, mutation, result JSON,
aggregate revision, event, and command record in one `BEGIN IMMEDIATE` transaction.
A duplicate registration yields `COMMAND_REGISTERED`.

Callbacks must be synchronous. Async/generator callbacks are rejected at
registration and returned promises reject with `ASYNC_HANDLER`, rolling back.
A synchronous callback must **not** initiate network requests, file generation,
or background work. Stage I/O outside the transaction, then persist its result
with a command. Never call `blobs.put` or nest `store.write` inside a handler.
This seam is for trusted engine code, not user-supplied JavaScript.

`ProjectStore` provides `get(sql, ...parameters)`, `all(sql, ...parameters)`,
`run(sql, ...parameters)`, `write(callback)`, `requireProject(projectId)`,
`aggregate(projectId, { kind, id })`, and `command(projectId, commandId)`.
User values must always be bound parameters. Handlers may write additional
domain tables in the current transaction; let the shared service record the
command/event and targeted aggregate exactly once. Later modules can create
their tables during initialization with `store.write`; central schema migrations
belong in `project-store.js`. Direct collaborators preserve low-level exceptions
for internal diagnosis; public service boundaries sanitize them.

## Storage and blob integrity

The directory contains `studio.sqlite` (schema version `1`, WAL, foreign keys,
5-second busy timeout), its SQLite journal files, and `blobs/<projectId>/<hash>`.
Project, production, aggregate, command, event, and blob registry records are
persistent. All writes use explicit transactions and bound SQL values.

`service.blobs.put(projectId, Uint8Array)` accepts bytes only and returns
`{ blobId, byteLength }`. It copies the input, hashes it, writes an exclusive
same-directory temporary file, fsyncs bytes, publishes with an atomic exclusive
hard link, removes the temporary name, fsyncs the leaf, blobs root and storage directory
in that order, then registers the blob in SQLite. Startup also syncs the blobs
root and its storage parent before any recovery registration. Parent directories
are synced on every publication, including retries after a failed first write. This is immutable publication: POSIX `rename` could overwrite
an existing destination, while an exclusive hard link cannot. Existing hash
paths are verified before reuse. Unsupported hard links and filesystem failures
are explicit errors and do not register bytes. A failed registry transaction
leaves durable orphan bytes for startup recovery.

Startup verifies registered blobs, marks missing/corrupt entries, and registers
only correctly hashed complete orphan files under existing projects. Temporary
crash remnants and corrupt orphan files are ignored. Reads require registration
in the requesting project and recheck both length and hash on every read.
Neither hashing, recovery nor registration emits an asset `candidate_ready`
event. Image/audio decoding, type checks, and candidate transitions belong to
the asset boundary in Task 4.

Tests use temporary on-disk databases and blobs, a fresh child process for
restart, two child processes racing CAS, actual OS permission failures, and a
SQLite trigger to exercise the publish-before-registry recovery window. No
provider, paid generation, browser, or renderer runs in these tests. Some
supported Node releases emit an experimental `node:sqlite` warning; this is
runtime noise. The bundled Node 24.19.0 run emitted no such warning.
