# Code copied from the Search Console source

The Google Health source watches for changes the way the Search Console source does. It keeps its own copy of that code and does not share it yet.

The reason is the Rule of Three: code that a second place needs is copied, and it is extracted only when a third place needs it. When a third consumer needs this code, the shared part moves to one place: the failed call in the fingerprint and the gauge over a function (backlog #2639). Until then, a fix in one copy is made in the other copy too, and the commit names both files.

Paths on the left are in `packages/sources/google/search-console/src`. Paths on the right are in `packages/sources/google/health/src`.

## Copied without a change

| Search Console                                         | Google Health                                        |
| ------------------------------------------------------ | ---------------------------------------------------- |
| `search-console-source.ts` `SearchConsoleSource#probe` | `google-health-source.ts` `GoogleHealthSource#probe` |

A call that fails is kept in the fingerprint as `{ failed: <message> }`, so a call that starts or stops failing wakes the streams; an abort is thrown.

## Copied with changes

**`probe.ts` `Probe` → `google-health-source.ts` `Fingerprint`.**
Both are a gauge of a fingerprint that a function reads at each check. The source gives the clock of the pipeline to the function in a closure, so a Retry-After wait is on that clock (elt ADR 0020).

- The name is `Fingerprint`, not `Probe`.
- `Fingerprint` is in the file of the source and is not exported. `Probe` is in its own file, because Search Console has two probes.

Why: Google Health has one probe, so its gauge has no file of its own. The function reads the whole check in both copies: the totals probe of Search Console reads the time of the check, and the Google Health probe reads only its signal.
