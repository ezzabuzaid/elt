# A rule failure stays on its output

A rule can fail on one input. For example, a stored PDF can be damaged. On 2026-10-27, a sync of Context Compiler read the text of 3,938 Mail files, and PDFKit failed on one of them. A run must not fail for one damaged file: then each sync fails, and no other file gets its text.

Thus a rule failure is the output of that input. The computed dataset keeps it in the row of the key, with the status `failed` and the reason. The load and the run continue. The next refresh tries that input again. pgai keeps the failures of its vectorizer in the same way, in the table `ai.vectorizer_errors`.

A dataset failure is different. It is a failure of the derived dataset itself, for example SQL that its store refuses. No sync history records it, so it rejects the run as itself, or it stops the watch.

## Considered Options

- **A rule failure fails the run.** One damaged file then fails each sync.
- **The rule tries each input again with a back-off.** This adds a retry policy to each rule before a rule needs one.
- **A rule failure is the output of its input, and the next refresh tries it again.** This option was selected.

## Consequences

- A reader finds each rule failure with SQL, for example `WHERE status = 'failed'`.
- An input that always fails is computed again at each refresh.
- A rule that finds its input gone, for example a stored file that a commit removed, gives `gone`. The dataset then keeps no row for it.
