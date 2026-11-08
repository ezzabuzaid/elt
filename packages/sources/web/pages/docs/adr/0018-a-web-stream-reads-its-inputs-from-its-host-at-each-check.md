# A web stream reads its inputs from its host at each check

`WebSource` took the inputs of each web stream when it was made ([ADR 0010](./0010-a-web-source-gives-many-web-streams.md)). A host that watches one pipeline for a long time could add an input only if it stopped the watch and made a new source and a new pipeline. Context Compiler's websets app adds an input when a search of a dataset finds a page and when a consumer makes a dataset over a new list. Thus it kept a loop that made the pipeline again, it tracked the passes that ran, and it refused with 409 a change that came while a crawl ran. What Is Going On restarted its watch for a new site, and the elt web app made its pipeline again on each Sync (elt backlog #3679).

elt itself did not need the inputs fixed. `Source.read` asks for the partitions at the start of each read, a new partition starts from `null`, and the rows of a removed partition stay. Only `WebSource` kept its inputs from its constructor, and its due time counted them.

The crawlers that crawl a page again on a schedule have the host write a new starting URL into the store that the crawl reads its due URLs from. Nutch's Injector merges URLs into the CrawlDb, and the Generator reads the CrawlDb at each round (nutch 2f6c28b, `Injector.java`, `Generator.java`). StormCrawler's injection topology writes into the status index, and its spouts query the index at most every two seconds (stormcrawler 6307734, `AbstractQueryingSpout.java`). Heritrix reads a `.seeds` file from the action directory of a job every 30 seconds (heritrix3 dec91bc, `ActionDirectory.java`). Crawlee pushes requests into a running crawler with `addRequests()` (crawlee 31467aa), and Airbyte applies a changed configuration at the next job (airbyte-python-cdk 314f8fb). No crawler deletes the pages of a removed starting URL.

## Decision

A web stream takes its inputs as a list of URLs that does not change, or as a function that gives them.

1. **A list of URLs is checked when the source is made.** Each URL becomes a `WebInput`. A URL that is not http or https makes the constructor throw `InputError`, as before.
2. **A function gives a `ReadonlySet<WebInput>`.** Only `webInput(href)` makes a `WebInput`: an http or https URL in the form that the URL standard gives it, or else `InputError`. Thus an input list holds no URL twice and no URL that is not a web page (Ezz, 2026-11-08).
3. **The source calls the function once as each read opens.** The web stream and its routes, crawls and failures streams read the same inputs, and the read's due times are complete once each of those inputs has one.
4. **A change of the inputs is a change signal.** Each web stream has a gauge whose value is its inputs in order. A watch checks it every second, as it checks the due time, so a change asks for a pass at the next check. An input that the host adds is crawled from its start in that pass. A pass of the connection that runs then ends first, as a URL that Nutch injects waits for the next generate round.
5. **A web stream may have no inputs.** It reads nothing, as an Airbyte partition router with no values gives no slices.
6. **A removed input keeps its rows**, as a removed partition does.

## Considered Options

- **A method that pushes inputs into the running source, as Crawlee's `addRequests()`.** The host then writes each input twice, to its own store and to the source, at each place that changes an input, and the two can disagree after a stop.
- **A version gauge beside the list.** The list itself is what a check compares, so a version tells nothing that the list does not (Ezz, 2026-11-08).
- **elt makes the source again between two passes, as Airbyte applies a configuration at the next job.** The host then keeps a loop that elt owns instead, and each change costs a new source and a new watch. A new input waits for the running pass in every option, since a pass reads the partitions as it opens.
- **The host's function, read at each check and at each read.** This option was selected.

## Consequences

- A host whose inputs change gives a function, such as websets' `() => new Set(urls.map(webInput))` over its own store, and makes its pipeline once.
- A host whose inputs do not change gives a list, and nothing changes for it.
- The function runs every second for each web stream, so it reads a local store or memory.
- `inputUrl` is the input in the form that the URL standard gives it. `https://example.com` is `https://example.com/`.
- This supersedes the sentence of ADR 0010 that each web stream has at least one input.
