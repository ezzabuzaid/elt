# A site limited to folders is named by folder URLs and tracked by item IDs

On 2026-11-18, a host needed one folder of a site and nothing else: the proposals of a site whose other libraries and folders hold staff CVs, photos and videos. The source read each site whole. elt has no filter of rows, and a field of a copy accepts a file by its name, not by its folder. Thus only the source can keep the rest of the site out of the warehouse, before it downloads a file.

Thus a site of the source is its URL, or `{ url, folders }`, where each folder is the full URL of a folder in a document library of the site.

- Each run finds each scope folder from its URL: the library whose `webUrl` starts it, then `GET /drives/{id}/root:/{rest}`. If no folder is there, the site fails with `SharePointFolderNotFoundError`, a `config` failure.
- The checkpoint keeps the scope folders and each item under them by ID, with the folder that holds it. Graph documents that a drive delta can leave out `parentReference.path`, and a rename of a folder gives none of its items again, so a path in the checkpoint would go stale.
- The first read takes `root/delta?token=latest` of each library, then lists the scope folders with `/children`. It reads the items of the scope folders, not every item of the library, and it does not depend on the order of a delta.
- Later reads read the delta of each library and keep the items whose folder is in the checkpoint. An item that leaves is deleted with each item under it. A folder that enters is listed, so a child that the delta gives before its new folder loads with that folder.
- `lists`, `listColumns`, `listItems`, `accessRequests` and `pages` load nothing for a scoped site. No record of them shows which folder holds it, and a list item gives only its URL. Apple Mail's source does the same for the streams that no proven account or message owns.

## Considered Options

- **A view or a filter in the host.** The host reads only what it wants, but every row and document of the site is still loaded and stored. The host needed the rest kept out.
- **A filter of rows in elt.** A filter after the source cannot stop a download, and on a delta it cannot turn a move out of the folder into a deletion. Fivetran's row filtering and Airbyte's mappings run after extraction for the same reason.
- **`ImportScope` with item IDs, as the Apple, Slack and Teams sources take.** IDs are what the source keeps, but a host cannot read them from SharePoint, and only LlamaIndex among SharePoint readers takes one, as an override of a path.
- **A library and a path relative to it, as Airbyte and dlt take.** Two fields say what one URL says.
- **Full folder URLs, as Azure AI Search (`includeFolder`) and Fivetran (a folder link) take.** This option was selected: the host copies the URL from the browser, and a folder belongs to its site by the shape of the option.

## Consequences

- A renamed or moved scope folder fails its site until the host gives its new URL. The source never loads nothing in silence.
- A scope change, or a change between a whole site and a scoped one, starts the site over with a `RESET`, so narrowing a site removes every row outside its scope folders.
- The checkpoint of `driveItems` grows with the items under the scope folders: one ID and one parent ID each.
- A folder that enters the scope is listed with one request for each folder under it.
- The first read saves a checkpoint after each page of children (#5292). Before, it saved one checkpoint for each library, after the whole listing. A first load of 716 MB failed four times before its end and stored every file again on each retry: the commit after the failure kept no row that named the stored files, so the next reconcile removed them. The checkpoint of a library whose first read is open is its walk: the delta link that the read took before it listed, the folders still to list, and the next link of the children of the folder that it lists now. A read that lists on keeps that delta link, so a change during the listing still comes in the read after it. A failure loses at most the page of children that the read was listing. Airbyte's CDK saves a checkpoint after each slice of a stream for the same reason (`Stream.read` and `state_checkpoint_interval` in `airbyte_cdk/sources/streams/core.py`, airbyte-python-cdk 95e87aff).
- A folder that enters the scope through a later delta is still listed whole inside the page of the delta that gives it, with no checkpoint of its own.
