# Code copied from elt

`src/web-crawler.ts` writes the message of a thrown value as `Error.isError(cause) ? cause.message : String(cause)` in two places: the message of `CrawlError`, and the message of the error for a robots.txt that the crawl cannot get. elt exports the same code as `errorMessage` (`packages/elt/src/state/sync-history.ts`). The package keeps its own copies and does not import it.

The reason is the direction of the dependencies. This package is an SDK, and the `layer:sdk` tag stops an SDK from depending on `@eltjs/elt` (elt `AGENTS.md`, "SDKs"). The code is one expression, and a small helper in a package with a different set of dependencies stays copied. A fix to `errorMessage` that changes what it gives is made in these copies too, and the commit names both files.

## Copied without a change

| elt `src/state/sync-history.ts` | crawler `src/web-crawler.ts`                         |
| ------------------------------- | ---------------------------------------------------- |
| `errorMessage(error)`           | `CrawlError` constructor                             |
| `errorMessage(error)`           | the error for a robots.txt that the crawl cannot get |

Both copies write the expression in a message template, not in a function.
