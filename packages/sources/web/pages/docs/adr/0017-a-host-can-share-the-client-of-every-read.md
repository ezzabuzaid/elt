# A host can share the client of every read

The crawls of a read share one record of each origin: its `robots.txt` rules, its delay, its block and its slowdown ([ADR 0014](./0014-the-crawls-of-a-read-share-the-record-of-each-origin.md)). The source opened that client with each read and closed it when the read ended.

On 2026-11-07, context-compiler's websets app needed to read a page on demand beside its crawl: `POST /v1/fetch` reads a page now with the crawler's rules. `WebArticle` of `@workspace/sdk-web-article` reads one page through any client, but the client of the crawl was internal to the source. A second client on the same cache file would keep its own records. A page read on demand and the crawl could then request one origin back to back, and the two clients would each save their records into the table `origins`, so the last save wins.

Crawlers that read a page on demand share the engine of their crawl. Crawlee's crawlers take an `httpClient`, and its `sendRequest` goes through the same client and session pool. Firecrawl's `/scrape` and `/crawl` use one engine. Nutch keeps one HostDb for every fetch.

## Decision

`WebSource` takes either `cachePath` and `userAgent`, as before, or `client`: a `WebClient` that the host opened with `WebClient.open(cachePath, userAgent, signal, clock)` from `@workspace/source-web-pages/web-client`.

1. **With `cachePath`, a read owns its client.** `open()` opens a client with the read's signal, and the end of the read closes it, as before.
2. **With `client`, a read borrows the host's client.** Every read and the host's own requests, such as `WebArticle` through `client.http`, pass one record of each origin. A borrowed read stops with its own signal and with the client's. Its end saves the records that changed, and it leaves the client open.
3. **The host closes the client.** It owns the client from `open` to `[Symbol.asyncDispose]()`, so the client has one owner, and the records have one writer.

## Considered Options

- **A second client in the host.** It keeps its own records, so the host and the crawl can request one origin back to back, and two clients write one table.
- **A method of the source that reads one page.** The source would then keep a client open between reads, and the host would not see when it opens and closes.
- **A client that the host opens and gives to the source.** This option was selected.

## Consequences

- A host that reads pages on demand opens one client, gives it to the source and to its readers, and closes it when it stops.
- A host that does not read pages on demand keeps `cachePath` and `userAgent`, and nothing changes for it.
- The options are a union: a host gives a client or a cache path, never both.
