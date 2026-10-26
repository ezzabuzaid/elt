# A failed page is tried again on the next run

A page can fail: its download fails after the retries of Got, or the extractor cannot read it. A feed rolls over, so a failed page can leave every listing before the next run. When the source forgets that page, its records are lost and nobody sees it.

Thus the crawl continues after a failure, and the source keeps each failed page in the `retry` part of the state. The next crawl gets these pages through the `pages` option of the crawler and hands them back before other pages. A page that then succeeds leaves `retry`, also when it gives no records. The source does not keep a failed listing, because the next crawl finds it again from the input. After the crawl, the source throws one `AggregateError` with all the failures. The engine reports it as a `PipelineError`, with the committed count of the input.

## Considered Options

- **Stop the crawl at the first failure.** One bad page then stops all the other pages of the input.
- **Skip a failed page.** Its records are then lost when the page leaves the listings.
- **Keep the failed page and give it to the next crawl.** This option was selected.

## Consequences

- The engine commits the records of the other pages.
- A page that always fails is reported on each run, until it recovers or the host changes the inputs or the `include` patterns.
- While a failure stays, `Pipeline.run()` rejects with a `PipelineError`, so the host sees that the run is not complete.
