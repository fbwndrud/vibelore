# Contributing

Use Node.js 22.x (22.13.0 or newer), 24.x or 26.x. There is no dependency installation
or build step.

```sh
git clone https://github.com/fbwndrud/vibelore.git
cd vibelore
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
The engine and MCP test suites run independently and together locally. GitHub CI
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
