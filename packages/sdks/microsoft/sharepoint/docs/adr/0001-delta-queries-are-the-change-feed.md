# Delta queries are the change feed

A host reads the files of a document library and the items of a list again and again. A library can hold thousands of files: on 2026-11-17, the Documents library of the first site had 5,725 files and 707 folders. A host must also learn which files and items were deleted.

Graph gives a delta query for a drive (`GET /drives/{id}/root/delta`) and for the items of a list (`GET /sites/{site}/lists/{list}/items/delta`). The first query gives every item, page by page. The last page has a delta link. A query from the delta link gives only the items that changed after it, and a deleted item has the `deleted` facet. Graph documents delta as the only way to read every item of a drive while people write to it: "Using `delta` is the only way to guarantee that you've read all of the data you need to" (driveItem: delta).

Thus `driveDelta` and `listItemsDelta` give the pages of a delta query, each with its `nextLink` or, on the last page, its `deltaLink`. The caller keeps the link of each page that it has written, so a read that stops goes on from the next page. When Graph answers 410 to a link, the call fails with `DeltaExpiredError`, and the caller reads the collection again with no link.

## Considered Options

- **List the folders and filter by `lastModifiedDateTime`.** This is the file-based route of Airbyte's `source-microsoft-sharepoint`. It reads every folder at each run and never sees a deletion.
- **Read the whole collection at each run, and compare.** It sees deletions, but each run reads every item of every library.
- **Subscribe to change notifications.** Graph sends them to a public HTTPS endpoint, which a host on a laptop or behind a firewall does not have. A notification also says only that something changed, so a delta query must still read the change.
- **Delta queries.** This option was selected.

## Consequences

- A delta can give the same item more than once. The caller keeps the last one.
- Graph documents that a delta can leave out `parentReference.path` and `cTag`. Live, with `$select`, items had both (2026-11-17). The schema keeps both optional.
- A delta link that Graph no longer serves fails one read with `DeltaExpiredError`, not a silent full read. The caller decides how to read the collection again.
- The SDK keeps no link. The caller stores each link with the data that the page before it gave.
