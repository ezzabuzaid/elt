# The crawls of a read share the record of each origin

Each input of a web stream is one partition with its own crawl memento, so an interrupted crawl continues from it ([ADR 0003](./0003-the-state-has-diff-crawl-and-retry.md)). The memento also held the manners of each origin: its block and its slowdown, and each crawl read `robots.txt` again. context-compiler's what-is-going-on app reads `https://www.anthropic.com/news`, `/research` and `/engineering` as three inputs of one stream, so each input paid its own 429 and asked `robots.txt` again (backlog items 3256 and 3505). Each extract opened its own HTTP client with a gate of two request starts a second, so the gate was one for each input, not one for the source. The extractor's own requests, such as the HTML companion of a Markdown page, passed no `robots.txt` and no breaker.

The crawler now keeps one record of each origin for a read (crawler [ADR 0006](../../../../sdks/web/crawler/docs/adr/0006-every-crawl-of-a-read-asks-one-record-of-each-origin.md)), as Heritrix keeps one `CrawlServer` for each host and Nutch one `FetchItemQueue`. The source owns where the records live and when the read starts, so:

1. **`open()` opens the HTTP of the read.** `WebClient` opens the HTTP cache in `cachePath` and the records of the origins from the table `origins` of the same file, as Nutch keeps its HostDb beside its crawl database. The read's context, `WebRead`, holds it beside the scan of the routes, and disposing the read closes it.
2. **Each extract makes the crawler of its input from the client.** `WebClient.crawler(readers, revisit, negotiation)` gives every crawler the same `Origins`. The revisit policy stays the copy's, so a full refresh still uses `AlwaysRevisit`. The extractor gets `Origins.http`, so its own requests pass the record of their origin.
3. **Each commit saves the records that changed.** After each checkpoint of a web stream, and when the read ends, the client writes each record whose value changed. A block and a slowdown thus outlive a process that stops, and a read asks `robots.txt` again only when its rules are 24 hours old.
4. **The gate of two request starts a second is gone.** The delay of each origin, one second or its `Crawl-delay`, replaces it, and the turn of one web stream at a time is gone too: two web streams that crawl at once wait for the same records.
5. **The crawl memento keeps only the frontier.** The per-input state keeps its crawl snapshot, its known URLs and its starting pages; `<name>_crawls` stays one row for each input.

## Considered Options

- **Keep the records in each input's state.** Each input then has its own block and slowdown, which is the defect.
- **Keep the records in a state of their own in the checkpoint store.** elt keeps one state for each stream and partition, and the records belong to the read of the whole source, not to a stream.
- **Keep the records next to the HTTP cache.** The host already chose that file for the source's HTTP, and a record of an origin, like a cached response, can be deleted to start cold. This option was selected.

## Consequences

- Two inputs on one origin share one `robots.txt` answer, one delay and one breaker in a read and across reads.
- Deleting the cache file also forgets the blocks, the slowdowns and the `robots.txt` rules.
- A state saved before this change does not parse; a fresh run rebuilds it (stored data is disposable).
- Two web streams of one read can crawl at the same time.
