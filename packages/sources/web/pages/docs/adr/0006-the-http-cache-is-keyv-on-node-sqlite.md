# The HTTP cache is Keyv on Node's SQLite driver

Every run revalidates each page ([ADR 0001](./0001-a-page-is-extracted-again-only-when-its-fingerprint-changes.md)). Without a cache, every run downloads every body again. Got keeps an HTTP cache through Keyv. Got 16.1.0 and cacheable-request 13.0.19 declare Keyv 5, and the `@keyv/sqlite` adapter for Keyv 5 used the native `sqlite3` module.

Thus the HTTP module opens Keyv 6.1.0 with `@keyv/sqlite` 6.1.0 and its `node:sqlite` driver. The cache file is the `cachePath` that the host gives to `WebSource`, and only its owner can read it. The root `package.json` overrides Keyv to 6.1.0 under `got` and `cacheable-request`. Each request sends `Cache-Control: no-cache`, so each run revalidates. When the server sends an ETag or a Last-Modified header, an unchanged page returns 304 without a body, and Got gives back the cached response. An error of the cache stops the crawl.

## Considered Options

- **A cache class of the source over SQLite.** On 35 real responses, it was about 3 ms faster for each pass than the adapter. That is not sufficient for the code that it needs.
- **Keyv 5 with the native `sqlite3` module.** This loads a native addon for a driver that Node already has.
- **Keyv 6 with `node:sqlite`, and overrides for Got.** This option was selected.

## Consequences

- No native SQLite addon loads. The adapter declares `better-sqlite3` for its other drivers, so npm installs it, but this configuration does not load it.
- The overrides go beyond the Keyv versions that Got declares. They are verified only for the web source and its SDKs.
- The cache is separate from the state. Delete the cache file to force cold requests.
- A response without validators downloads again. The cache does not keep a `no-store` response.
