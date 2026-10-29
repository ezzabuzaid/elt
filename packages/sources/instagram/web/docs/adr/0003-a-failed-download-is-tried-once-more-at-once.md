# A failed download is tried once more at once

The source downloads the images of posts, stories and highlights from Instagram's CDN. On 2026-10-15, one download of about 800 failed with "fetch failed", and on 2026-10-16 the CDN answered one image with 503 Service Unavailable. Each failure failed its stream.

`fetch` reports a dropped or refused connection as a `TypeError`. A 5xx tells that the server could not serve the file this time. A GET of a CDN image is safe to do again. Thus `InstagramWeb.download` tries a download one more time, at once, when its connection fails or when the CDN answers with a 5xx.

Airbyte's HTTP client tries such errors again up to five times, with backoff, and its default error mapping tries 5xx answers and connection errors again in the same way. One immediate retry is the smaller step.

## Considered Options

- **Fail at the first error.** One dropped connection then fails the stream.
- **Try again up to five times with backoff, as Airbyte does.** This is more than the failures seen.
- **Try one more time, at once.** This option was selected.

## Consequences

- A 429 is still a rate limit that stops the run.
- Other 4xx answers fail at once. A 410 Gone loads the record without its file.
- A download whose second try fails still fails its stream. Highlight items commit page by page, so such a failure loses only its page (see ADR 0001).

## Sources

- Commit 114d6b2c: a connection that fails is tried once more.
- Commit 6891f30b: a 5xx from the CDN is tried once more, as a dropped connection is.
