# Source and data provenance

**Status: released under Apache-2.0 from a cleaned tree; see
[release-review.json](release-review.json) for the recorded approval.**

[LICENSE](../LICENSE) records the license text and [NOTICE](../NOTICE) records
known references. The maintainer confirmed the right to publish their reader
engine. Third-party material identified during review was removed or replaced
as described below; the approval covers the cleaned tree, not the history
behind it.

The 0.1.0 release of 2026-09-13 was withdrawn the same day for this review.
Copies downloaded while it was public cannot be recalled. The pre-review
commits and the withdrawn tag are kept as private audit evidence and are not
part of the public history, which starts from the cleaned tree.

## Code and compatibility layers

`src/` and `engine/src/` contain the standalone vibelore implementation. The local
`mini-schema` and test `vitest-shim` implement the small interfaces needed by this
project using JavaScript and Node.js built-ins. They do not install or bundle Zod
or Vitest. The two package manifests have no external npm dependencies.

The standalone engine came through an earlier reader project. Its dated design
records specify an independently implemented replacement, and the initial engine
commit introduced a separate package. This documents the intended development
process; it does not prove that every implementation followed that process.
Obsolete host paths and unsupported originality assertions have been removed
from product comments. Factual provenance stays in this document.

## InkOS reference and replacement data

[InkOS](https://github.com/Narcooo/inkos) was a reference for genre identifiers,
workflow comparisons, and metadata-leak regression scenarios. Its current source
is licensed under [AGPL-3.0-only](https://github.com/Narcooo/inkos/blob/091048383f411eb99948a8764f42b6fd13006f9b/LICENSE).
This reference is attribution, not a relicensing of InkOS.

The historical genre-frontmatter word lists in `style-lexicon.js` were removed
before public distribution. The replacement seed was authored for vibelore on
2026-09-13. It selects five short, general narrative transition phrases for each
language and three short cues for each genre, covering repetitive explanations,
stock reactions, and repetitive genre mechanics. These are soft repetition cues,
not prohibited vocabulary, and their usefulness is not a literary benchmark.
The implementation accepts a custom seed when a work needs different cues.

The 25 existing genre identifiers remain stable so saved projects can still be
opened. The StoryState hook record previously shared its field names and
lifecycle values with the InkOS runtime-state schema. On 2026-09-14 it was
redefined with vibelore's own vocabulary (`id`, `text`, `plantedAtChapter`,
`phase: planted|advancing|paid|parked`, `horizon: next|soon|arc|long|finale`,
`lastMovedChapter`). Snapshots written with the earlier field names are
normalized on load, so existing projects keep opening. The imported word lists were removed before the withdrawn public release.
No InkOS dependency or binary is included. Historical comments, external marker
labels, and identifiable historical character/work fixtures have now been removed
or replaced in the source tree. This is cleanup, not evidence that no
adapted prompt or other protected expression remains.

## Review evidence and remaining decision

The review compared the current upstream source and the actual historical fork
used by the reader project, including its Korean prompt additions. The local
fork has 1,100 reachable commits. The review uses both normalized text fragments
and lexical token sequences to find candidates, followed by manual inspection.
These checks can detect some copying despite formatting changes. They cannot
exclude translation, paraphrase, or other adaptation, and they are not legal
clearance. Detailed private evidence is kept outside this repository.

A second pass on 2026-09-14 compared the cleaned tree against the current
InkOS source with word-sequence matching. No prompt or prose overlap remained;
the only shared vocabulary was the StoryState hook schema, which was redefined
(see above). Translation or paraphrase cannot be excluded by such matching, so
the recorded approval is the maintainer's decision, not a mechanical result.
Keep required attribution and license notices; do not remove them to conceal
provenance.

`npm run check:source` checks the tree's files and metadata.
`npm run check:release` additionally requires the explicit recorded approval in
`release-review.json`; CI runs it on every push.

## Manuscripts and examples

Tests use short regression fixtures. A historical character/work identity was
replaced with a neutral test identity during this review. Private novels, model
transcripts, evaluation archives, and personal host configurations are excluded
from the source tree. This review does not newly license any user's
private writing.

The repository license does not claim ownership of a user's manuscripts. Rights
to model-generated output depend on the user's input, model service, and other
applicable terms; vibelore does not assign a license to those outputs.

## Contributions

Record the original URL, version, license, and modifications for any third-party
material introduced by a contribution. Preserve required notices. Do not copy
source, prompts, example prose, or datasets whose redistribution terms have not
been checked. See [CONTRIBUTING.md](../CONTRIBUTING.md).
