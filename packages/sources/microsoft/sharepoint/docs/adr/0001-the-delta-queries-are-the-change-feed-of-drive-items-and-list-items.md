# The delta queries are the change feed of drive items and list items

A site of SharePoint holds many files and list items: the site probed on 2026-11-17 had 5,727 files, 314 folders and about 6,450 list items, and its main library changed each day. A host wants each change and each deletion, and each pass must not read the whole site.

Graph gives a delta query for a drive (`/drives/{id}/root/delta`) and for the items of a list (`/sites/{id}/lists/{id}/items/delta`). The first read gives each item, page by page, with a next link on each page and a delta link on the last page. A read from the delta link gives each item that changed after it. A deleted item has the `deleted` facet. This is the change feed of sync strategy 1 of the add-elt-source skill: a feed that gives the changed and the deleted keys after a position.

Thus `driveItems` and `listItems` read the delta queries ([SDK ADR 0001](../../../../sdks/microsoft/sharepoint/docs/adr/0001-delta-queries-are-the-change-feed.md)):

- The checkpoint of a site is the delta link of each collection, or the next link of the page that a read got to, and the fields that the reads carried.
- Each page ends in a checkpoint. Thus a first load that fails continues at the next link that it saved.
- An item with the `deleted` facet is a `DELETE` of its key.
- A collection that is new starts its own first load, with no `RESET`: it adds rows and deletes none.
- A `RESET` starts the site over when Graph answers 410 for a link, when a collection of the checkpoint is gone, or when the stream has a field that the checkpoint was read without.
- The root folder of a drive is not a row: a drive delta gives it on each page, with no `eTag` and no author, and `drives` describes the drive.

A `RESET` of a partition replaces the rows of the partition at its next commit ([elt ADR 0007](../../../../elt/docs/adr/0007-a-stream-that-starts-over-reloads-into-a-hidden-target.md)). Only a `RESET` of a full stream reloads into a hidden target. A checkpoint after each page of a reload would show readers a part of the site until the reload ends. Thus a reload sends its checkpoint only at its end, and commits one time.

## Considered Options

- **A cursor on `lastModifiedDateTime`.** Airbyte's `source-microsoft-sharepoint` (e70913f86) is file-based: it lists the files of a drive and keeps those modified after its cursor. It sends no deletions and reads no lists. A deleted file stays in the warehouse, and each read lists the whole drive.
- **A snapshot of each full listing.** Each pass would read each item of the site, 31 pages for one drive of the probed site, and would hold a snapshot of each key in the checkpoint.
- **The delta queries.** This option was selected.
- **A checkpoint after each page of a reload.** A reload that fails would continue. But readers would see only the pages that the reload read until it ends.
- **One commit at the end of a reload.** This option was selected. A reload that fails starts again.

## Consequences

- A pass with no change reads one page for each collection.
- A reload reads each collection of the site again, and downloads again each file that a copy accepts. A 410 on one library reloads each library and each list of the site, because the reset scope is the partition.
- A reload holds its rows in the stage of the destination until it commits, not in memory.
- elt has no reload of a partition into a hidden target. When it has one, a reload can send a checkpoint after each page.
