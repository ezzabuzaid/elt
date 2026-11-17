# SharePoint source

A host wants the files, lists and pages of SharePoint Online sites in its warehouse, with their changes and deletions, and the text of their documents. The SharePoint source makes streams from what the SharePoint SDK reads through Microsoft Graph. The words of Graph, for example site, drive, list, delta link and next link, are in the glossary of the [SDK](../../../sdks/microsoft/sharepoint/CONTEXT.md). The words of elt, for example stream, partition, checkpoint and reset, are in the glossary of [elt](../../../elt/CONTEXT.md).

## Language

**Site URL**:
The URL of a site as the host wrote it, such as `https://contoso.sharepoint.com/sites/Sales`. It is the partition of each stream and the first field of each primary key.
_Avoid_: Site ID (Graph's ID of the site, the `siteId` field), tenant

**Collection**:
What one delta query reads: a document library for `driveItems`, a list for `listItems`. A site has many collections.
_Avoid_: Container, folder, source

**Delta stream**:
A stream that reads the delta query of each collection of a site: `driveItems` and `listItems`. Its first read loads each item, and later reads apply the changes after each delta link.
_Avoid_: Incremental stream, change stream

**Snapshot stream**:
A stream that Graph lists in full on each read, which an incremental copy compares with the snapshot of the last read: `sites`, `drives`, `lists`, `listColumns`, `accessRequests` and `pages`.
_Avoid_: Full stream, listing

**Delta state**:
The checkpoint of a delta stream for one site: the fields that its reads carried, and the delta link or the next link of each collection.
_Avoid_: Cursor, token, watermark

**Reload**:
A read of each collection of a site from the start, after a `RESET`, because the delta state can no longer tell what changed. It commits one time, when it ends.
_Avoid_: Resync, backfill, refresh

**Access request list**:
The hidden list of a site, with the template `accessRequest`, that holds the requests of people for access to the site. Graph refuses its item delta, so `accessRequests` reads it in full.
_Avoid_: Permission list, sharing list

**Accepted file**:
A file of `driveItems` whose name a field of the copy accepts, for example a Word document when the field accepts what the Office parser reads. Only an accepted file is downloaded.
_Avoid_: Document (a document is one kind of accepted file), attachment

**Staged file**:
The downloaded content of an accepted file, in a folder of the run, named `<itemId><extension>`. The source removes it after the consumer takes its record.
_Avoid_: Download, temporary copy, cache
