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
The engine and MCP test suites run independently and together in CI.

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
