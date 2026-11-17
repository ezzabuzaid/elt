# @eltjs/sdk-microsoft-sharepoint

Reads SharePoint Online through Microsoft Graph, as one app with an app-only token. This SDK knows nothing of elt. [@eltjs/source-microsoft-sharepoint](../../../sources/microsoft/sharepoint/README.md) uses it to make the streams of a pipeline. The words of this README are in the [glossary](./CONTEXT.md).

```ts
import { SharePointClient } from '@eltjs/sdk-microsoft-sharepoint';

const client = new SharePointClient({
  tenantId: '0b7f3f60-1f2c-4c5e-9d0a-6a1f2e3d4c5b',
  clientId: 'c3a1f0e2-5b6d-4e7f-8a9b-0c1d2e3f4a5b',
  clientSecret: 'the client secret of the app',
  clock: globalThis,
});
const signal = AbortSignal.timeout(10 * 60_000);

const site = await client.site(
  'https://contoso.sharepoint.com/sites/Sales',
  signal,
);
const deltaLinks = new Map<string, string>();
for (const drive of await client.drives(site.id, signal)) {
  for await (const page of client.driveDelta(drive.id, undefined, signal)) {
    if ('deltaLink' in page) deltaLinks.set(drive.id, page.deltaLink);
  }
}
```

- `SharePointClient` takes the app registration of Microsoft Entra ID (`tenantId`, `clientId`, `clientSecret`) and a `clock`, which an app gives as `globalThis`. It gets the app-only token for `https://graph.microsoft.com/.default` with `@azure/msal-node`, which keeps the token in memory until it expires. The client reads no environment variable: the host gives each value.
- Each call is a GET to `https://graph.microsoft.com/v1.0` and takes a `signal`, which stops the request and each wait between tries.
- `site(url, signal)` gives the site at a URL such as `https://contoso.sharepoint.com/sites/Sales`. Every other call takes the `id` of this site, not its URL ([ADR 0002](./docs/adr/0002-a-sites-selected-app-cannot-list-its-sites-so-callers-name-site-urls.md)).
- `drives(siteId, signal)` gives the document libraries of the site.
- `lists(siteId, signal)` gives the lists of the site, with their template and their hidden flag. The document libraries are lists too.
- `columns(siteId, listId, signal)` gives the columns of a list. `type` is the facet that Graph gives for the type of the column, such as `text` or `choice`, with its settings, or `null` for a type that Graph does not model.
- `pages(siteId, signal)` gives the modern pages of the site, without their content. `textWebParts(siteId, pageId, signal)` gives the HTML of the text web parts of one page, in the order of its canvas.
- `driveDelta(driveId, link, signal)` and `listItemsDelta(siteId, listId, link, signal)` give the pages of a delta query ([ADR 0001](./docs/adr/0001-delta-queries-are-the-change-feed.md)). Without `link`, they give every item. With `link`, a `nextLink` or a `deltaLink` of an earlier page, they give the pages after it. Each page has `items` and a `nextLink`, or `items` and a `deltaLink` on the last page. An item with `deleted` was deleted. A drive delta selects the fields that a file or a folder needs, such as `size`, `file.hashes`, `parentReference.path` and `sharepointIds.listItemId`, and never `@microsoft.graph.downloadUrl`, a pre-signed URL that changes at each read. A list items delta gives the `fields` of each item.
- `download(driveId, itemId, path, signal)` writes the content of a file to `path` as it arrives. The file is not kept in memory.
- `SiteVersion` is a `Gauge<string>` of `@zukhruf/async` for a site URL. Its value changes when the `lastModifiedDateTime` of a list or a page of the site changes, or when a list or a page is added or removed. Each read asks Graph for the site, its lists and its pages: three requests.

## Retries

A request that Graph answers with 429, 503 or 504 is sent again, five times in all. The `Retry-After` of Graph is the wait. A `Retry-After` of more than 60 seconds fails the call at once. Without a `Retry-After`, the wait doubles from 1 second to at most 60 seconds, with full jitter. Each wait runs on the `clock` of the client. This code is a copy of the retry of `@eltjs/google-auth` ([the ledger](./docs/copied-from-google-auth-retry.md)).

## Errors

| Error                         | The cause                                                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SharePointAccessError`       | Graph refused the token (401) or the access (403). `resource` names the site URL, the site ID or the drive of the call. The app needs a Sites.Selected read grant on the site. |
| `SharePointSiteNotFoundError` | No site is at the URL that `site` got (404).                                                                                                                                   |
| `DeltaExpiredError`           | Graph no longer serves the changes after the link (410). Read the collection again, with no link.                                                                              |
| `GraphError`                  | Graph refused the request for another reason. `status` and `code` are those of Graph, such as 400 `invalidRequest` for a malformed delta link.                                 |

Each error of the first three kinds keeps the `GraphError` as its `cause`.

## Live checks

On 2026-11-17, with the app-only token of an app that holds only `Sites.Selected`, against a tenant of SharePoint Online:

- The token holds only the role `Sites.Selected`.
- `GET /sites?search=*`, `GET /sites/getAllSites` and `GET /sites/root` answer 403. The app cannot list its sites.
- A site that exists and that the app has no grant on answers 403. A site that does not exist answers 404.
- `GET /sites/{id}/permissions` answers 403, so the app cannot read the role of its own grant.
- The drive delta of each document library of the granted site, and the list items delta, end with `@odata.deltaLink`.
- A malformed delta token answers 400 `invalidRequest`. An expired one answers 410, as Graph documents. No expired link was available to check.
- With `$select`, the items of a drive delta include `parentReference.path` and `cTag`.
- Two full reads 5 seconds apart, with no edits, gave the same site, drives, lists, columns, pages and drive delta items, byte for byte.
- `GET /sites/{id}/pages/{id}/microsoft.graph.sitePage?$expand=canvasLayout` answers 200.
- A drive delta gives the root folder of the drive on each of its pages: 31 times over the 31 pages of a library of 5,725 files. The root has no `eTag`.
- The item delta of the hidden list of template `accessRequest` answers 503 `serviceNotAvailable` at each try, while `GET /sites/{id}/lists/{id}/items` answers 200. `listItems` reads such a list in full.
- One full pass of the granted site parsed with these schemas: 6 drives, 10 lists, 5,727 files, 314 folders, about 6,450 list items and 4 pages. The drive deltas gave the 314 folders 682 times: a delta gives a folder again when its children change, and the last time is the current one.

Not checked live: that the `lastModifiedDateTime` of a list moves when one of its items changes, which `SiteVersion` uses. The app has only a read grant, and no test site is available. The next changes that people make to the site show it.

## Limits

- Graph leaves out the lists that it marks `system`. The columns of a list and the `fields` of its items leave out the hidden columns.
- A delta query can give the same item more than once. The last one is the current one. Graph documents that a delta can leave out `parentReference.path` and `cTag`, so both are optional.
- `textWebParts` reads only the text web parts. Other web parts, such as images and embedded documents, give no text. It is one request for each page.
- The client reads no versions of files and no permissions of items.
- A download is one request with no resume. Graph redirects it to a pre-signed URL on the SharePoint host. `fetch` follows the redirect and does not send the `Authorization` header to the other origin (checked on Node.js 26.13).
- The client takes a client secret, not a certificate.
