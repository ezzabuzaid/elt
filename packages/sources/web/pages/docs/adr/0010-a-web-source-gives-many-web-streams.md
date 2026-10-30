# A web source gives many web streams

A marketplace has two kinds of record: its categories and the listings of each category. The OpenSooq connector of Context Compiler shows the categories of OpenSooq Jordan as a choice, and it loads the listings of the categories that the user chose. A connector lists its choices from the rows of one stream of its source. The categories come from the hidden menu of the home page, and the listings come from the category pages. `WebSource` gave exactly one web stream, and all its inputs were inputs of that stream.

Thus `WebSource` takes a list of web streams, and the host gives each web stream its own inputs. Each web stream is one stream of the catalog, with its inputs as partitions, its own coverage and its own target. Airbyte's declarative sources do the same: one source for each upstream, with many streams, and each stream has its own requester and paginator. A child stream, such as the commits of each repository, reads its partitions from a parent stream through `SubstreamPartitionRouter`. dlt reads a child resource from its parent with `@dlt.transformer(data_from=...)`.

## Considered Options

- **Two sources for one site: one `WebSource` for the categories and one for the listings.** `WebSource` does not change. But a source is the code that reads one upstream, and Airbyte, dlt and the scrapers of OpenSooq on Apify all use one source for each site. The connector also loads one source.
- **A source class of OpenSooq that wraps `WebSource`.** The class must replace the catalog that the `WebSource` constructor makes, and override its partitions and its extraction. That is the inside of `WebSource`, and the next site with two streams must do it again.
- **`WebSource` takes many web streams, each with its own inputs.** This option was selected.

## Consequences

- The constructor takes `streams: [{ stream, inputs }]`. Each web stream has at least one input, and two web streams cannot have the same name.
- The listings of the chosen categories are a child stream in the sense of the host: the connector gives the chosen category URLs as the inputs of the listings stream. `WebSource` does not read one stream's rows to make another stream's inputs.
- All the crawls of a source share the HTTP cache and the user agent. Each input of each web stream is still crawled separately, so each crawl has its own memento, block and slowdown (backlog item 3256 is about one crawler for each site).
- A watch reads again only the web streams that have a page due. A stream whose page is not due is not crawled, so its starting URLs are not requested again.
