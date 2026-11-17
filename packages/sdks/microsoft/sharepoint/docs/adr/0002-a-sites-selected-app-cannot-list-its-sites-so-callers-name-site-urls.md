# A Sites.Selected app cannot list its sites, so callers name site URLs

An app reads SharePoint with the least access that it needs. With the Graph permission `Sites.Selected`, an app reads only the sites that an administrator granted to it, one grant for each site. With `Sites.Read.All`, an app reads every site of the tenant.

On 2026-11-17, with an app that holds only `Sites.Selected` and a read grant on one site, Graph answered 403 to each request that lists sites: `GET /sites?search=*`, `GET /sites/getAllSites` and `GET /sites/root`. It also answered 403 to `GET /sites/{id}/permissions`, so the app cannot read its own grants. An existing site with no grant answered 403, and a site that does not exist answered 404.

Thus `site(url)` takes the URL of one site and gives its ID, and every other call takes that ID. The host names its site URLs in its configuration. Airbyte's `source-microsoft-sharepoint` also takes a `site_url`.

## Considered Options

- **Ask for `Sites.Read.All` and list the sites.** The app could then read every site of the tenant. That is more access than the host needs, and the administrators of a tenant often refuse it.
- **Search for the sites.** Search answers 403 to a `Sites.Selected` app.
- **The host names the site URLs.** This option was selected.

## Consequences

- To read one more site, an administrator grants it to the app, and the host adds its URL.
- A URL with no grant fails with `SharePointAccessError`, which names the URL. A URL with no site fails with `SharePointSiteNotFoundError`.
- The app cannot confirm that its grant is read-only. The SDK sends only GET requests.
