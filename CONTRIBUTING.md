# Contributing

Use Node.js 22.x (22.13.0 or newer), 24.x or 26.x. The core engine/MCP has no
runtime dependencies or build step. Studio is a local component of the repository
checkout with its own lockfile; install its dependencies before full validation.

```sh
git clone https://github.com/fbwndrud/vibelore.git
cd vibelore
npm ci --prefix studio
npm run test:all
npm run check:source
```

`npm run check:release` additionally requires the recorded release approval in
`docs/release-review.json`. Passing tests and source checks are necessary for a
release, not a substitute for that recorded decision.

Open a focused issue or pull request explaining the concrete problem, resulting
behavior, and relevant validation. For fixes affecting manuscripts, include a
small synthetic regression at the actual MCP or storage boundary. Do not commit
personal novels, model transcripts, credentials, or `.vibelore` state. Copy
[the example ignore file](examples/work.gitignore) into a work's Git repository
if the manuscript is intentionally version-controlled.

Use [private security reporting](SECURITY.md) for vulnerabilities. Keep code and
documentation aligned; update the tool reference when an input contract changes.
`npm run test:core` runs engine/MCP; `npm run test:studio` runs Studio;
`npm run test:all` runs all three, including the release gate. Studio tests need
FFmpeg/ffprobe and installed Chrome plus the optional locked Remotion/React
packages for actual video validation. Set `STUDIO_CHROME_PATH` to the Chrome
executable outside macOS (or to override its macOS default). Video checks report
unsupported runtimes explicitly. Studio's default test concurrency is one because
multiple short Chrome/FFmpeg renders compete for local resources. Source metadata
checks remain separate from tests. GitHub CI
and CodeQL workflows are disabled; pull requests and releases use local validation.
This does not provide the former platform matrix, CodeQL analysis or history-wide
secret scan. GitHub Pages publication is separate and remains enabled.

Webtoon changes must preserve novel canonical files and approval boundaries.
Use small synthetic manuscripts and images; exercise new workflows through
actual MCP stdio as well as the individual tools. Keep legacy fixtures explicitly
named, and for the deprecated per-panel path test mandatory rough approval on the current policy. Fixture reviews
test orchestration, not visual quality. Verify the package includes the webtoon
skill, linked documentation, bundled font and its OFL notice with
`npm pack --dry-run --json`. Private episodes and generated art do not belong here.

Apache-2.0 is the intended license for contributions. Confirm that you have the right to
contribute the material, retain required copyright notices, and record external
sources and licenses in [NOTICE](NOTICE). Do not add generated
artifacts whose source or redistribution rights are unknown.

The maintainer reviews changes before merging. Keep PRs small enough to review,
and explain any compatibility or recovery-format changes.

## Offline A/B evaluation (developers)

`scripts/pairwise-evaluation.js` compares two sets of chapters written from the
same starting point, one with a feature off and one with it on, by asking a judge
model which of each pair reads better. It is a developer-only measurement. It is
not an MCP tool, is not part of the writing flow, and is not packed into the npm
package.

Prepare the sets by copying the whole work root, including hidden state, twice.
Enable the feature in the ON copy only, then run the same chapter range with
`lore_write` in both copies. For a noise baseline, make a second OFF copy, write
the same range in it, compare the two OFF copies and label that run
`--feature baseline`.

```sh
node scripts/pairwise-evaluation.js --off <off-root> --on <on-root> \
  --out <output-dir> --language <code> [--chapters 1-5,8] [--answers <file>] \
  [--feature <label>] [--judge-label <text>] [--writer-model <id>] [--timeout-ms <n>]
```

`--off` and `--on` may be repeated and must be given the same number of times;
the Nth `--off` is compared with the Nth `--on`. `--language` selects the judge
prompt family. `--out` must be outside this repository and every input root, and
the script only reads the input roots.

Without a local endpoint the script works through a request file. It writes
`requests.json` to the output directory and exits with code 2. Answer each
request independently, from its `system` and `user` text alone, collect the
answers as `{"<id>": "<answer text>"}` in a JSON file and run the same command
again with `--answers <file>`. A malformed answer may need one more round, in
which case a repair request appears in the next `requests.json`. Once every
request is answered, `report.json` and `report.md` are written and the script
exits with code 0. Exit code 1 means an error.

To judge with a local OpenAI-compatible endpoint instead, set
`VIBELORE_LOCAL_BASE_URL` and `VIBELORE_LOCAL_MODEL`; no request file is written.

Read results as follows.

- They are LLM-judge preferences, not human evaluation.
- Judging through the host relay is labelled not independent. A local endpoint's
  model id is only declared and stays unverified.
- Length is not normalized; the report notes a large length difference between the
  sets, which can sway a judge on its own.
- The script never writes into a work, never gates a commit or release, and no
  model runs inside `npm test`.

## Release conventions

Run `npm run check:publish` before merging release changes. It runs both test suites,
source and version-specific approval checks, whitespace validation, and a real package
build with file allowlist, required files and tarball integrity checks. It leaves the
verified tarball in a temporary directory and prints its path and integrity.

After committing the prepared version and its approval, use:

```sh
npm run release:npm -- --dry-run
npm run release:npm
```

Both commands require a clean checkout on supported Node.js and run the checks.
The first prepares the verified package without publishing. The second publishes
the exact tarball it verifies to npm with `latest`; any failed check stops publication.
Direct `npm publish` from the source checkout also runs `check:publish` through
`prepublishOnly`. Do not bypass scripts or publish an independently packed tarball:
those npm paths bypass the local gate. A successful npm command is followed by the
registry and GitHub verification below; keep the printed tarball integrity as evidence.

- Use `vibelore <version>` for every GitHub release title, for example `vibelore 0.4.8`.
- Use `v<version>` for its Git tag, for example `v0.4.8`, targeting the verified release commit.
- Write release notes in English, even when the source changelog entry is in Korean.
  Preserve code identifiers and quoted language examples as written.
- Mark the newest stable published version as GitHub's `Latest`; do not make a backfilled older release latest.
- A release includes both npm publication and GitHub release publication. Verify the npm version,
  `latest` dist-tag and package integrity, then verify the GitHub title, tag, notes and `Latest` marker.

For example, publish prepared English notes with:

```sh
gh release create v0.4.8 --repo fbwndrud/vibelore --target <release-commit> \
  --title "vibelore 0.4.8" --notes-file <english-release-notes> --latest
```
