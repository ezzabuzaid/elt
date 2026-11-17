# @eltjs/source-microsoft-sharepoint

An ELT source for SharePoint Online sites. It reads the files, the lists and the pages of each site through Microsoft Graph, as one app with an app-only token. [@eltjs/sdk-microsoft-sharepoint](../../../sdks/microsoft/sharepoint/README.md) owns the calls to Graph. This source owns the streams, their schemas and how they sync.

The words in this README have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

```ts
import { join } from 'node:path';

import {
  Connection,
  Copy,
  DocumentText,
  LocalFiles,
  Pipeline,
} from '@eltjs/elt';
import {
  ComputedDataset,
  SQLiteCheckpointStore,
  SQLiteColumns,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@eltjs/elt-sqlite';
import { OfficeDocumentParser } from '@eltjs/parser-office/office-document-parser';
import { SharePointClient } from '@eltjs/sdk-microsoft-sharepoint';
import { SharePointSource } from '@eltjs/source-microsoft-sharepoint/sharepoint-source';

const tenantId = '0b7f3f60-1f2c-4c5e-9d0a-6a1f2e3d4c5b';
const source = new SharePointSource({
  client: new SharePointClient({
    tenantId,
    clientId: 'c3a1f0e2-5b6d-4e7f-8a9b-0c1d2e3f4a5b',
    clientSecret: 'the client secret of the app',
    clock: globalThis,
  }),
  sites: ['https://contoso.sharepoint.com/sites/Sales'],
});
const warehouse = './outputs/warehouse';
const destination = new SQLiteDestination({
  path: join(warehouse, 'warehouse.sqlite'),
});
const files = new LocalFiles({
  directory: join(warehouse, 'sharepoint-files'),
});
const parser = new OfficeDocumentParser();

// The documents that the parser reads are stored; photos and videos stay in
// SharePoint.
const driveItems = destination.table('sharepoint_drive_items', (c) => [
  ...SQLiteColumns.fromSchema(source.driveItems.jsonSchema),
  c
    .text('documentRef')
    .from(source.driveItems.file.accepting(parser).store(files)),
]);
const { streams } = await source.discover();

await new Pipeline({
  clock: globalThis,
  history: new SQLiteSyncHistory(),
  connections: [
    new Connection({
      name: 'sharepoint',
      source,
      destination,
      checkpoints: new SQLiteCheckpointStore({
        path: join(warehouse, 'checkpoints.sqlite'),
      }),
      steps: streams.map(
        (stream) =>
          new Copy(
            stream,
            stream === source.driveItems
              ? driveItems
              : destination.table(`sharepoint_${stream.name}`),
            {
              id: `${source.identity}/${stream.name}`,
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
            },
          ),
      ),
    }),
  ],
  derived: [
    new ComputedDataset({
      into: destination,
      name: 'sharepoint_document_text',
      description: 'The text of each stored SharePoint document.',
      from: [driveItems],
      compute: new DocumentText({
        parser: () => parser,
        files: files.directory,
        column: 'documentRef',
      }),
    }),
  ],
}).run();
```

## How to use it

1. Make a `SharePointClient` from the app registration of Microsoft Entra ID: the tenant ID, the client ID and a client secret. The host reads these values, for example from its environment. The source and the SDK read no environment variable.
2. Make a `SharePointSource` with the client and the URL of each site. The identity of the source is `sharepoint:<tenantId>`, the tenant of the client.
3. Copy each stream with `syncMode: 'incremental'` and `destinationSyncMode: 'append_dedup'`. Each stream deduplicates on its primary key and sends deletions. Give each copy an ID that holds the source identity, such as `sharepoint:<tenantId>/driveItems`, so that two tenants can be in one pipeline.
4. To get the text of documents, store the files of `driveItems` with `file.accepting(parser).store(files)`, and derive their text with a `DocumentText` computed dataset (see [elt](../../../elt/README.md#attachment-text)). A file that the parser cannot read gets a row with its error in the dataset, and fails no copy.

Each site is a partition of each stream, with a checkpoint of its own. Thus a site that you add starts from the start, and the other sites keep their checkpoints. `siteUrl` is in each record and first in each primary key. It is the URL as the host wrote it.

## Access

The app needs the Graph application permission `Sites.Selected`, and an administrator must grant it read access to each site. With `Sites.Selected`, the app cannot list its sites, so the host names them ([SDK ADR 0002](../../../sdks/microsoft/sharepoint/docs/adr/0002-a-sites-selected-app-cannot-list-its-sites-so-callers-name-site-urls.md)).

| Error                         | When                                                                  | Failure type |
| ----------------------------- | --------------------------------------------------------------------- | ------------ |
| `SharePointAccessError`       | Graph refused the token (401) or the access to a site (403).          | `config`     |
| `SharePointSiteNotFoundError` | No site is at a URL (404).                                            | `config`     |
| Any other error               | Graph failed in another way, for example 500 or a refused delta link. | `system`     |

A site that fails fails only its partition. The other sites load and save their checkpoints.

## Streams

| Stream           | One record for                                                             | Primary key                     | Sync     |
| ---------------- | -------------------------------------------------------------------------- | ------------------------------- | -------- |
| `sites`          | the site at each URL                                                       | `siteUrl`, `siteId`             | snapshot |
| `drives`         | each document library                                                      | `siteUrl`, `driveId`            | snapshot |
| `driveItems`     | each file and folder of each document library, with the file               | `siteUrl`, `driveId`, `itemId`  | delta    |
| `lists`          | each list, hidden lists and document libraries included, with its template | `siteUrl`, `listId`             | snapshot |
| `listColumns`    | each column of each list, with its type                                    | `siteUrl`, `listId`, `columnId` | snapshot |
| `listItems`      | each item of each list but the access request lists, with `fields` as JSON | `siteUrl`, `listId`, `itemId`   | delta    |
| `accessRequests` | each item of each access request list, with `fields` as JSON               | `siteUrl`, `listId`, `itemId`   | snapshot |
| `pages`          | each modern page, with the HTML of its text web parts                      | `siteUrl`, `pageId`             | snapshot |

- Each timestamp is UTC, in the millisecond form of elt, such as `2026-11-17T09:30:00.000Z`.
- A value that Graph does not give is `NULL`.
- `size` and `childCount` are integers. A file of SharePoint is at most 250 GB, far below 2^53.
- `createdBy` and `lastModifiedBy` are the identitySet of Graph as JSON, for example `{"user":{"id":"…","displayName":"Sam","email":"sam@contoso.com"}}`. `fields` of a list item and `settings` of a column are JSON too. Read a part with `json_extract`.
- A file of a document library is also an item of the list of the library. `driveItems.listItemId` is the `itemId` of that item in `listItems`, which holds the metadata columns of the library, such as a sector or a year.
- The root folder of a library has no row in `driveItems`: `drives` describes the library. The `parentId` of an item at the top of a library names the root folder.

## Sync

**Delta** streams read through the delta queries of Graph ([ADR 0001](./docs/adr/0001-the-delta-queries-are-the-change-feed-of-drive-items-and-list-items.md)). A collection is a document library for `driveItems`, and a list for `listItems`.

- The first read of a site loads each collection, page by page. Each page ends in a checkpoint. A first load that fails continues at the next link that it saved, and does not read its first pages again.
- Later reads read the changes after the delta link of each collection. An item with the `deleted` facet is a `DELETE`. Each page of changes ends in a checkpoint.
- A collection that is new on the site starts its own first load. The other collections continue from their links.
- The site starts over with a `RESET` and loads each item again in these cases:
  - Graph no longer serves a delta link (410).
  - A collection of the checkpoint is gone from the site, for example a removed library. A delta tells no deletion for a collection that is gone.
  - The stream has a field that the checkpoint was read without. A delta gives only the items that changed, so a new field would get values only on those items.
- A reload commits one time, when it ends. A `RESET` of a partition replaces the rows of the partition at its next commit ([elt ADR 0007](../../../elt/docs/adr/0007-a-stream-that-starts-over-reloads-into-a-hidden-target.md)). Thus readers keep the old rows of the site until the reload ends. A reload that fails starts again on the next run.

The checkpoint of a site is `{ fields, links }`: the fields that the reads carried, and for each collection ID `{ delta }`, its delta link, or `{ next }`, the next link of the page that a read got to.

**Snapshot** streams list their records in full on each read. An incremental copy compares each read with the snapshot of the last read, writes only the records that changed, and deletes the keys that Graph no longer lists (`ClosedWorld`).

`accessRequests` is a snapshot stream because Graph refuses the item delta of an access request list ([ADR 0002](./docs/adr/0002-a-list-whose-delta-graph-refuses-is-read-in-full.md)). The source finds these lists by their template, `accessRequest`. `listItems` does not read them.

A full refresh reads each stream in full, with no checkpoint and no deletion.

## Files

`driveItems` supports file transfer. A copy selects what it takes from a file in its columns (see [elt](../../../elt/README.md#stored-files-and-document-parsing)).

- The source downloads a file only when a field of the copy accepts its name: `configuration.fileReads.some((read) => read.accepts(name))`. `file.accepting(new OfficeDocumentParser())` accepts only the names of Office documents and PDF files. Thus no photo or video is downloaded.
- The download goes to a folder of the run, as `<itemId><extension>`. The extension is `fileExtension(name)` of elt. The source removes the file after the consumer takes its record, and removes the folder when the run ends.
- A folder, and a file that no field accepts, gives `file: null`. A field of such a record is null.
- A file that Graph no longer has when the source downloads it (404) gives `file: null`. The delta tells its deletion on the next read.
- A delta gives a file again when its content or its metadata changes. Each time, the source downloads it again, and `LocalFiles` keeps one copy of the same content.

## Watching

`changeSignals` gives one `SiteVersion` of the SDK for each site. Each tells about each selected stream. A watch reads each one every 60 seconds, and one read can take 30 seconds. A read is three requests to Graph: the site, its lists and its pages. Its value changes when the `lastModifiedDateTime` of a list or a page changes, or when a list or a page is added or removed. A document library is a list, so a change to a file changes the value too.

Graph sends change notifications (webhooks) only to a public URL, so the source does not use them.

## Limits

- The `fields` of a list item and the `settings` of a column pass through JSON numbers. SharePoint keeps Number and Currency columns as doubles, so each value loads exactly; only its text can differ from what Graph sent, such as `1.1` for `1.10`.
- The snapshot streams read each collection whole: the columns of a list, the pages of a site and the items of an access request list. SharePoint keeps these small. Files and list items go through the delta feeds, one page at a time.

- The source reads no versions of files and no permissions of items. `/sites/{id}/permissions` answers 403 to a `Sites.Selected` app.
- The source reads no text from images or videos. The text of documents is derived data: a `DocumentText` dataset of the host makes it.
- Graph leaves out the lists that it marks `system`, and the hidden columns of a list and of its items.
- A reload loads each collection of the site again, and downloads again each file that a field accepts.
- `pages` asks Graph for the canvas of each page on each read: one request for each page.
- A delta can give the same item more than once. The last one is the current one, and the copy keeps it.
- Graph documents that a drive delta can leave out `parentReference.path` and `cTag`. Then `path` and `cTag` are `NULL`.
- The client takes a client secret, not a certificate.

## Live checks

On 2026-11-17, with the app-only token of an app that holds only `Sites.Selected`, granted read on one site of a tenant of SharePoint Online:

- The app cannot list sites: `GET /sites?search=*`, `GET /sites/getAllSites` and `GET /sites/root` answer 403. A site that exists and that the app has no grant on answers 403. A site that does not exist answers 404.
- The granted site had 6 drives, 10 lists, 5,727 files, 314 folders, about 6,450 list items and 4 pages. Its drive deltas gave the 314 folders 682 times: a delta gives a folder again when its children change, and the copy keeps the last one. Its Documents library held about 72 GB, of which about 70 GB were photos and videos (jpg, mp4, mov), and about 714 documents (docx, pdf, pptx, xlsx).
- The drive delta of each library, and the list items delta of each list but one, end with a delta link.
- A drive delta gave the root folder of the drive on each of its pages: 31 times over the 31 pages of one drive. The root folder has no `eTag` and no `createdBy`.
- Graph answered the item delta of the hidden list with the template `accessRequest` with 503 `serviceNotAvailable` on each try, while `GET /sites/{id}/lists/{id}/items` answered 200.
- Two full reads with no edits between them gave the same values. No value changes from one read to the next.
- `GET /sites/{id}/pages/{id}/microsoft.graph.sitePage?$expand=canvasLayout` answers 200.

Not checked live:

- An expired delta link: none was available. Graph documents a 410, and the tests stub it.
- That the `lastModifiedDateTime` of a list moves when one of its items changes, which `SiteVersion` uses. The app has only a read grant, and no test site is available.
- A pass of this source over the site. `src/sharepoint-live.test.ts` makes one, and skips unless `SHAREPOINT_TENANT_ID`, `SHAREPOINT_CLIENT_ID` and `SHAREPOINT_CLIENT_SECRET` are set. It downloads only the workbooks of the site.

## Decisions

- [ADR 0001](./docs/adr/0001-the-delta-queries-are-the-change-feed-of-drive-items-and-list-items.md): the delta queries are the change feed of drive items and list items.
- [ADR 0002](./docs/adr/0002-a-list-whose-delta-graph-refuses-is-read-in-full.md): a list whose delta Graph refuses is read in full.
