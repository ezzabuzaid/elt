# An absent page is not a deletion

Feeds roll over, and sitemaps and archives change. A page that a listing no longer names can still exist. The source cannot know whether the publisher deleted a page.

Thus the stream declares no deletions. When a complete crawl does not hand back a page, the diff of elt removes the page from its state and emits no DELETE. The row of that page stays in the destination.

## Considered Options

- **Delete the rows of the pages that a complete crawl did not find.** A feed that rolls over then deletes the rows of its older pages.
- **Keep the rows, and forget the pages that a complete crawl did not find.** This option was selected.

## Consequences

- A row stays after its page leaves every listing. A full refresh replaces the rows with the pages of the current crawl, but only when that crawl succeeds.
- When the host removes an input or changes the `include` patterns, the rows that the source loaded stay in incremental mode.
- When a forgotten page comes back in a later crawl, the source extracts it again, because the diff no longer has its fingerprint. Backlog item 3011 records a policy to visit pages again across crawls.
