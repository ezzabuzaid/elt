# The state has diff, crawl and retry

Superseded by [ADR 0008](./0008-a-known-page-is-requested-again-when-its-revisit-policy-says.md).

The engine saves one state for each input, after it commits the records that came before that state. Three owners know parts of what the next run needs. The diff of the engine knows the committed pages and their fingerprints. The crawler knows its frontier. Only the source knows which pages failed.

Thus the state has one part for each owner:

- `diff`: the comparison state of the engine. The source does not read it.
- `crawl`: the crawl snapshot of the unfinished crawl, or null when the crawl is complete.
- `retry`: the pages that failed, each with its `listingUrl` and `lastModified`.

The source saves the state after each page that the crawl hands back and after each failure. While the crawl reads only listings and archives, it hands back no pages, so the source saves the state at most one time each second.

## Considered Options

- **A store of the source for its own progress.** The source then needs a second store and its own rule for when a commit is complete. The engine already saves the state after the records before it.
- **One state with a part for each owner.** This option was selected.

## Consequences

- A run that stops does at most the last page again. The diff skips that page when it did not change.
- A run after a complete crawl starts a new crawl from the input, so it can find new pages and changes anywhere.
- Each save writes the full state again. With a large listing, this is much data for each page. Backlog item 2920 records this.
- When the shape of the state changes, an old state does not parse and the run fails. A run from an empty state builds it again.
