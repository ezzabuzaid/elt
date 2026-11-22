# SharePoint

A host wants the files, lists and pages of SharePoint Online sites. This SDK reads them through Microsoft Graph, as one app with an app-only token. This glossary gives the words that the README and the decisions use.

## Language

**Site**:
A SharePoint site, such as `https://contoso.sharepoint.com/sites/Sales`. Graph gives it an ID of three parts, `<host>,<site collection>,<web>`. Each other call names the site by this ID.
_Avoid_: Tenant, web, team

**Drive**:
A document library of a site: its files and folders, as Graph shows them. A drive is also a list of the site.
_Avoid_: Library alone, folder, share

**Drive item**:
A file or a folder of a drive. The root folder of a drive is a drive item too.
_Avoid_: Document, entry

**List**:
A list of a site, such as an Events list. Its template says what kind of list it is. A document library is a list with the template `documentLibrary`.
_Avoid_: Table

**List item**:
One item of a list. Its `fields` hold its value of each column, by the column's `name`.
_Avoid_: Row, record

**Column**:
A field that the items of a list have, with its type and its settings.
_Avoid_: Field definition

**Page**:
A modern page of the Site Pages library of a site. Its canvas holds web parts. A text web part holds HTML that people wrote.
_Avoid_: Wiki page, document

**Delta query**:
A read of a drive or a list that gives its items page by page, and then only the items that changed after a delta link. A deleted item has the `deleted` facet ([ADR 0001](./docs/adr/0001-delta-queries-are-the-change-feed.md)).
_Avoid_: Sync, changes API, poll

**Next link**:
The link of the next page of a delta query or of the children of a folder, while it has more pages.
_Avoid_: Cursor, skip token

**Delta link**:
The link on the last page of a delta query. A later delta query starts at it and gives the changes after it. Graph can stop serving a delta link; it then answers 410.
_Avoid_: Cursor, token, watermark

**Sites.Selected**:
The Graph permission that lets an app read only the sites that an administrator granted to it, one grant for each site. With it, an app cannot list its sites ([ADR 0002](./docs/adr/0002-a-sites-selected-app-cannot-list-its-sites-so-callers-name-site-urls.md)).
_Avoid_: Sites.Read.All, site permission

**Site version**:
The value that changes when the content of a site changes: the `lastModifiedDateTime` of each list and each page of the site.
_Avoid_: ETag, change token
