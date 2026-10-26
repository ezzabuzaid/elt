# Code copied inside the crawler

`ArchiveReader` and `PaginationReader` both read a list page: they find its pagination and the pages it lists. `PaginationReader` keeps its own copy of that code, and does not share it with `ArchiveReader` yet.

The reason is the Rule of Three. It counts places, not packages. Code that a second place needs is copied, and it is extracted only when a third place needs it. The boundary of the shared code then comes from three working copies, not from a guess. The next reader that reads the pages a list page links is the third place. When it comes, the shared parts move to one function that each reader uses (backlog #3097). Until then, a fix in one copy is made in the other copy too, and the commit names both files. This note is the input for that step.

Both paths are in `packages/sdks/web/crawler/src`.

## Copied with changes

**`archive-reader.ts` `readArchive` → `pagination-reader.ts` `readPagination`.**

- Only pagination links are kept: the `paginationLinks` relations (`next`, `prev`, `next-archive`, `prev-archive`) in HTTP `Link` headers, link elements and anchors. `readArchive` also takes `rel="archives"`, archive paths, calendar paths and labels such as "Older posts".
- Link elements and anchors are matched with every `paginationLinks` relation. `readArchive` matches them with `archives`, `next` and `prev` only.
- The pages that the page lists are found as in `readArchive`: same-origin anchors outside `nav`, `footer` and `[role="navigation"]`, without the pagination links.

Why: a site such as OpenSooq ends its year filters and its other language's category in a year. `PaginationReader` must follow only what the page declares.

## Not a copy

The two `read` methods are not copies. `ArchiveReader` reads every HTML page and takes the archives that any page links. `PaginationReader` reads only the starting pages and the pages that their pagination reaches.
