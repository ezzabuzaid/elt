# A failures stream is the dead-letter output of a web stream

ADR 0013 lets a crawl be complete when some of its pages failed, and says that a reader that needs a failed page waits for that page, "as a stream processor moves its watermark past a failed record and sends the record to a dead-letter output". The web source gave no such output. A reader saw a page that the crawl read and that gave no record, and a page that failed, in the same way: as no row. The startup-credits app of Context Compiler logs a program as missing when no link of a list leads to a program page, after the crawl of the list is complete. It must not log a program whose page failed: the page can be a program page that a bot challenge hides, and the app logs the failure itself. So it waited for a record of each linked page, and a linked page that gave no record, such as a page with only a heading, kept its program unreported for ever (backlog item 3502).

Only the crawl knows which pages failed: its memento keeps the last outcome of each URL, and only the crawler knows which URLs are pages that it would hand back. Thus `Crawl.failures()` gives those pages, and each web stream gives a fourth stream, `<name>_failures`, with one row for each input and page whose last visit failed:

- `inputUrl`, the input and the partition key.
- `url`, the page.

A page leaves once a visit of it succeeds. A document that failed, such as a sitemap or a starting URL, is no row: no reader waits for it as a record. The rows of an input are the failures that its last crawl left, so the stream reads only incrementally, after its web stream in the same read, with `ClosedWorld` deletion. A crawl that did not run in a read keeps the rows of its input.

Kafka Connect's dead-letter queue (`errors.deadletterqueue.topic.name`) keeps the record that failed and, by default, no reason (`errors.deadletterqueue.context.headers.enable` is false). The row keeps no reason either: the crawl reports the reason of each failure through `PipelineError` in the run where it fails, and the memento keeps no reason.

## Considered Options

- **The outcome of every visit**, as Nutch's CrawlDb and StormCrawler's status index keep one status for each URL. It answers more than a reader asks, and it gives one row for each URL that the crawl ever visited, sitemaps included.
- **The failures that the sync history keeps.** The history keeps each failure as an error message, and a reader would parse the URL out of the text.
- **A failures stream.** This option was selected.

## Consequences

- A reader that concludes from an absence behind the crawls stream reads `SELECT url FROM <name>_failures WHERE inputUrl = ?` and waits only for those pages: a linked page with no record and no failure gave no record.
- The test `a page whose last visit failed is a row of the failures stream until a visit of it succeeds, also through a read that a record ends, and a sitemap that failed is none` proves this rule.
