# Security

Security fixes target the latest public release and `main`. This is a local,
single-user MCP server; it is not an authenticated multi-tenant service.

Report vulnerabilities privately using
[GitHub private vulnerability reporting](https://github.com/fbwndrud/vibelore/security/advisories/new).
Include the affected version, a minimal synthetic reproduction, and the expected
and observed behavior. Do not attach credentials, unpublished manuscripts, or
complete `.vibelore` directories to public issues.

## Trust and data boundaries

- The MCP host supplies the project path. The server reads and writes there with
  the permissions of the Node.js process; it is not an operating-system sandbox.
  Connect only trusted hosts and use a separate directory for each work.
- The default host-relay path returns manuscript context to the connected host.
  Its model service can receive that context under the host's settings and terms.
  Local storage does not mean the connected model runs locally.
- `.vibelore` stores drafts, model requests/responses, approvals, and recovery data
  in plaintext. Protect and back up it as carefully as the manuscript itself.
- The optional local model adapter sends context to the explicitly configured
  `VIBELORE_LOCAL_BASE_URL`. It has no authentication mechanism; use a trusted
  local endpoint. Each request has a 120-second timeout.
- Webtoon generation jobs expose source excerpts and reference-image paths to
  the host. The host may send them to the chosen image service; API credentials
  belong in the host environment, never MCP arguments, feedback or transcripts.
  The server issues jobs and imports local images; it does not execute paid
  image API calls. Import paths and hashes are validated, but this is not an
  image malware scanner. Open generated previews only in a trusted environment.
- The lettering reader uses the bundled, hash-tracked font, not arbitrary
  user-supplied font binaries. Keep its OFL notice with the distributed font.
- MCP frames are limited to 16 MiB and the pending input queue to 32 MiB. Tool
  arguments are validated without coercion. One MCP operation at a time may
  access a work across server processes; use a local filesystem.
- Rollback validates version-2 snapshots before changing the work, preserves a
  backup, and resumes interrupted materialization on the next MCP call. Old
  approvals and pending model runs are archived rather than replayed.
- A legacy snapshot without a version-2 manifest is rejected. See
  [recovery instructions](docs/OPERATIONS.md#전체-rollback).

Keep Node.js on a supported, patched release. The supported families are Node
22.x (minimum 22.13.0), 24.x and 26.x. Model judgments and prose-quality checks are not
security boundaries. Maintain an independent backup of valuable manuscripts.
