# Each pass tries an input at most once

A computed dataset stores a rule's failure on its row, and a refresh tried each failed row again. A refresh came after each pass, so a failing input was tried once for each pass. ADR 0017 of `elt` adds refreshes while a pass reads, at each commit. With the old rule, a model that refuses an input, such as a rate limit, would be asked again at each commit of a long pass. On 2026-10-31, the startup-credits tests of Context Compiler showed this as unplanned model requests, and the attachment-text tests showed a file whose read failed computed again in the same sync.

Thus each pass tries an input at most once, as before:

- A refresh gets its trigger from the pipeline: `commit` while a pass reads, `pass` after the passes.
- A commit refresh makes new inputs and inputs whose input or rule identity changed. It leaves failed rows as they are.
- The trigger carries what the passes tried: the pipeline keeps, for each dataset, the inputs that commit refreshes of the passes that run tried, by key, input hash and rule identity. It keeps them in memory and drops them after the refresh after the passes. A commit refresh adds to them, and no refresh tries an input that they hold again.
- The refresh after the passes tries each failed row again that the passes did not try. A row that a commit refresh failed is thus tried by the refresh after the next pass, also in a new process: the memory ends with its passes, and nothing that is stored says which refresh failed a row.

Airbyte's platform tries a failed sync again after a back-off and not at once (`AirbyteWorkerRetryConfig.kt`), and elt's watch tries a failed copy again with a back-off (`pipeline.ts`). For a rule, the pass is the unit of a try, because the host decides how often passes run.

## Considered Options

- **Every refresh tries a failed row.** A refusing model is asked at each commit.
- **A commit refresh skips failed rows, and every pass refresh tries them.** A row that a commit refresh failed is tried again at the end of the same pass: two tries in one pass.
- **A stored column says which refresh failed a row.** It has no identity of the pass: after a restart, a row that a commit refresh of a stopped pass failed looks like a failure of the next pass, and is not tried.
- **Each pass tries an input at most once, from a memory of its passes.** This option was selected.

## Consequences

- A rule failure that a commit refresh records stays `failed` until the refresh after the next pass.
- The tests `a row that fails during a pass is tried again only by the refresh after the next pass, as each pass tries it once` and `a row that a refresh during a stopped pass failed is tried again by the refresh after the pass of a restarted pipeline, once` prove this rule.
