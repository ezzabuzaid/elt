# Code copied from the Search Console source

The Google Health source watches for changes the way the Search Console source does. It keeps its own copy of that code and does not share it yet.

The reason is the Rule of Three: code that a second place needs is copied, and it is extracted only when a third place needs it. When a third polling source needs this code, the shared part moves to one place (backlog #2639). Until then, a fix in one copy is made in the other copy too, and the commit names both files.

## Copied without a change

| Search Console                                         | Google Health                                        |
| ------------------------------------------------------ | ---------------------------------------------------- |
| `search-console-source.ts` `SearchConsoleSource#probe` | `google-health-source.ts` `GoogleHealthSource#probe` |

A call that fails is kept in the fingerprint as `{ failed: <message> }`, so a call that starts or stops failing wakes the streams; an abort is thrown.
