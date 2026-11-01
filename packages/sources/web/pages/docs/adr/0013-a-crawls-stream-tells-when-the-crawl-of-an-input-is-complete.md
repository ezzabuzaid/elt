# A crawls stream tells when the crawl of an input is complete

Derived data now follows each commit (ADR 0017 of elt), and routes reach their table during the crawl (ADR 0012). A reader that concludes from an absence then reads a crawl that is not complete. The startup-credits app of Context Compiler logs a program as missing when no route from its link reaches a program page. On 2026-10-31, its tests logged "no program page found" for programs whose program page the crawl had not reached yet.

A stream processor answers this question of completeness with a watermark: Flink and Beam advance a watermark per source split once no older data can come, and a window fires only behind it. Airbyte's stream status gives `COMPLETE` once a stream has read everything. elt has neither for one partition. `stream_status` and `extraction_coverage` record that a copy succeeded, but a crawl that the expansion budget holds back succeeds and is not complete (ADR 0005 of the crawler): its memento keeps the held documents for the next run. Only the crawl knows that its frontier is empty, so the web source owns this job.

Thus each web stream gives a third stream, `<name>_crawls`, with one row for each input:

- `inputUrl`, the input and the key.
- `complete`: the crawl of the input ended with an empty frontier (`crawl.snapshot().crawl` is `null`). A budget, a blocked host or a stopped crawl gives false. A failed page does not: it is due again later (two hours, ADR 0004), and a reader that needs that page waits for it page by page, as a stream processor moves its watermark past a failed record and sends the record to a dead-letter output instead of holding every window ([ADR 0015](./0015-a-failures-stream-is-the-dead-letter-output-of-a-web-stream.md)). Otherwise one page that always fails, such as a site behind a bot challenge, would keep its input incomplete for ever.
- `since`: when the crawl that first gave this value of `complete` ended.

The crawls stream reads after its web stream in the same read, and takes how each input's crawl ended from the scan. It reads only incrementally: its state keeps the last row, so it gives a row only when `complete` changes, and an unchanged rerun gives nothing. A crawl that did not run in a read, such as an input after a failed full refresh, keeps its row.

## Considered Options

- **A column in each record.** A record is one page, and an input has many pages; an input whose crawl gives no page has no record.
- **elt's `currentAsOf` of the stream.** It answers for a stream, not for one input, and a crawl that was never complete has no time to give.
- **A crawls stream in the web source.** This option was selected.

## Consequences

- A host reads `SELECT inputUrl, complete, since FROM <name>_crawls` and waits for `complete` on the inputs that it reads.
- The test `an input whose crawl the expansion budget holds is reported incomplete, and complete since the run that finishes it` proves this rule.
