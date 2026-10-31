# A web stream gives its routes as a second stream

The crawler gives each route that a read found: a listing named a URL, with how and with its text ([ADR 0004 of the crawler](../../../../sdks/web/crawler/docs/adr/0004-every-route-is-kept.md)). A record keeps only `listingUrl`, the listing that first supplied its page. The startup-credits app in context-compiler must decide, for each page that a list links, whether a route from it reaches a program page. It must also match the rows of two lists by the text of the list.

Thus `WebSource` gives a second stream for each web stream, `<name>_routes`:

- It is a junction stream, as Airbyte's source-github has `team_members` (manifest 052e56e41b), with the primary key `[id, team_slug]` and one row for each relation. Its primary key is `inputUrl`, `listingUrl` and `url`. Its other columns are `how` and `text`. Its name comes from the web stream, as Airbyte names a child stream from its parent.
- A listing that a crawl reads again completely replaces its rows. A URL that the listing no longer names loses its row, through a DELETE. An incomplete read, where a reader threw or skipped the response, adds its routes and deletes none: a part of an observation does not replace a whole one. A listing that a run does not read keeps its rows. The diff of elt gives this with the `Coverage` policy: a vanished row is deleted only when its listing was read completely in the run.
- The routes stream reads only incrementally. Only the listings that a crawl reads replace their rows, so a full refresh could not give the rows of the other listings.
- The routes come from the crawl of the web stream, so recording a route requests nothing again. `WebSource` reads each web stream before every routes stream in one read. Each input's crawl gives its routes to the read, and the routes stream of that input loads them after the crawl ended.
- The web stream and its routes stream commit their states separately. The web stream's state is a transactional outbox: it keeps each group of routes that its routes stream did not commit, with a number, in the same commit as the crawl's progress. The routes stream's state keeps the number of the first group that it did not commit, as a consumer offset. `WebSource.open` reads that number from the routes stream's state, which `Source.read` gives to `open` with the read's states, and the web stream's next crawl leaves out every group below it, in every process. A run that stops after the web stream commits and before the routes stream commits thus gives those groups again in the next run.
- New groups have numbers after every group that the outbox holds and after the routes stream's number. A web stream whose state starts over, as in a full refresh, thus never reuses a number that the routes stream committed.

## Divergence from ADR 0005

[ADR 0005](./0005-an-absent-page-is-not-a-deletion.md) stays true for pages: a page that a listing no longer names can still exist. It does not apply to routes. A route is a fact about one read of one listing. When the listing is read again and does not name the URL, the route is gone, so its row is deleted.

## Considered Options

- **Keep the routes in the web stream's records.** A record is one page, and a page has many routes. Each route would also change the fingerprint of its page, so the source would extract unchanged pages again.
- **A routes stream with its own crawl.** Its crawl requests every URL again, or two crawls must share their responses, and two mementos can decide differently when a URL is due.
- **A routes stream that reads the crawl of its web stream.** This option was selected.

## Consequences

- A host loads the routes stream in the same connection as its web stream. A read that does not select the web stream gives no routes, and the rows stay.
- A read that selects the web stream but not its routes stream records no routes. A later read gives the routes of the listings that it reads.
- The web stream's state holds the routes of the last read with the routes stream, until the next read with it. A read without the routes stream keeps the outbox as it is and adds nothing to it.
- When the routes stream fails in a run, the routes of the listings that the run read come again when the crawl reads those listings again.
