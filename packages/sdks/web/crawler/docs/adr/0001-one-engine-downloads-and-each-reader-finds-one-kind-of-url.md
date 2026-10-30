# One engine downloads and each reader finds one kind of URL

A crawl finds pages in sitemaps, feeds, archives, lists and ordinary links. Before this package, `WebDiscovery`, the standalone `WebLinks` and `WebSource` each kept a queue, a visited set and a download loop. Two of them had copies of the feed parser and of the rules that select a declared feed. The split followed the route to a page (listings or links), not the reason to change.

Thus one engine, `WebCrawler`, keeps the frontier and downloads. Each kind of URL has one reader. A reader reads one response and returns what it finds. It does not download, queue or call another reader. The crawler gives each response to every reader in the order that the host gives them. The readers are independent, and two readers do not do the same work. This is the URL frontier of _Introduction to Information Retrieval_, chapter 20, and the way Crawlee routes responses by request label.

## Considered Options

- **Each route keeps its own crawler.** One job then has many queues, visited sets and download loops, and the copies of the parsers must agree.
- **One engine downloads, and readers find URLs.** This option was selected (commit 26768c44, which removed `sdk-web-discovery` and `sdk-web-links`).

## Consequences

- A change to what the crawl finds goes into the reader that owns that kind of URL. A new kind of URL gets a new reader.
- No reader keeps a second queue or downloads.
- The engine knows no format. It knows only the roles that a reader gives a URL: page, document or list.
- When a reader cannot read a response, the crawl reports a failure for that URL, and the other readers still read the response.
