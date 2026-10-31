# A page that a list hands back on another origin is expanded one step

This decision replaces [ADR 0002](./0002-the-crawl-expands-only-the-starting-origins.md).

A host chooses websites and gives the crawl their starting URLs. Before this decision, the crawl expanded only the starting origins: `LinkReader` followed ordinary links only on those origins, and `ListingReader` read `robots.txt` only for a starting URL. Two readers kept the rule, and each one learned it from `request.start`.

The startup-credits app in context-compiler (backlog items 3396 and 3407) found a case that this rule cannot serve. The app crawls lists of startup programs on GitHub with `PaginationReader({ strategy: 'all' })`. A list links the home page of each company, such as `vercel.com/` or `pinecone.io/`. The program page is at another URL of that website, or on another origin:

- `vercel.com/startups` is a link in the menu of the home page.
- `pinecone.io/startup-program/` is only in the sitemap.
- The program of Linode is at `akamai.com/cloud/start-ups`.

In the HTTP cache of the 2026-10-30 run, 9 of 36 home pages link their program page, and the sitemaps give 5 more.

Thus the crawl scopes each URL by how the crawl reached it:

- The engine owns the rule, as the URL filter of a crawler (_Introduction to Information Retrieval_, figure 20.1) and the scope of Heritrix do. The host gives `expand` URL patterns beside `include`.
- The engine marks how readers expand each request (`request.expand`). A starting URL is `'origin'`: readers expand its origin as before. A page that a list hands back (a finding with `linked` false from a list) on an origin that no starting URL names is `'step'`. A sitemap entry and a feed item are also zero hops, but they are not lists' pages, so the engine does not mark them.
- `LinkReader` reads the links of a `'step'` page on every origin. `ListingReader` reads the declarations of a `'step'` page and its origin's `robots.txt`, and the `/sitemap.xml` guess has the same rule as for a starting page.
- From a `'step'` page, the engine keeps only the pages and lists that match `expand`. It keeps every document, such as `robots.txt`, a sitemap index and a sitemap, and it applies the same rule to their findings. The mark is plain data on the request, as `list` is, so the memento keeps it.
- Expansion is one step. The engine expands nothing that an expansion found.
- With no `expand` patterns, the engine marks no `'step'` page, and the crawl is as before.

No leading crawler makes a linked URL a starting URL: Heritrix does that only after a redirect (`seedsRedirectNewSeeds`). The hop paths of Heritrix (`L`, then `LL` or `LPM`) and Crawlee's `enqueueLinks` for each request handler express the case: a rule that depends on how the crawl reached the URL.

## Considered Options

- **Give each listed home page as a starting URL.** The host then needs a second crawl for each list, and each home page is expanded with no limit.
- **Expand every origin that a list links.** One list then reaches every website that its pages link, and the work has no limit.
- **Expand a list's page on another origin one step, and keep only what matches `expand`.** This option was selected.

## Consequences

- `include` selects the pages that the crawl hands back, and `expand` selects what an expansion keeps. The crawl downloads a `'step'` page only when `include` selects it, or when a reader wants it.
- The readers do not read `request.start` for scope. `StartReader` reads it to hand back each starting URL, and `PaginationReader` reads a starting page as a list.
- The engine keeps the origins of the starting URLs in the crawl snapshot, so a resumed crawl marks the same pages.
- An expansion finds noise, such as blog posts and legal pages whose URLs contain the word of a pattern. The host removes it with its own rules: the startup-credits app labels each page by its kind.
- A crawl that follows links from page to page across origins by topic is a focused crawler. That is a separate design (backlog item 3327).
