# History expires only for a browser that removes it

Status: accepted, 2026-11-02.

## Context

Chromium removes a visit 90 days after it occurred (`kExpireDaysThreshold` in `history_backend.h`). It removes a visit of a frame that loaded by itself 3 days earlier (`kEarlyExpirationAdvanceDays` in `expire_history_backend.cc`). A URL and its searches go with their last visit. Chromium records no deletion for these rows.

Not all browsers do this. On 2026-11-02, Chrome held no visit older than 90 days. Dia and Arc held visits from more than a year before, and their `early_expiration_threshold` in `meta` was still in 1971. Dia held 79,960 visits older than 90 days.

A snapshot diff deletes each key that is not in the read. For Chrome, a visit that Chromium removed by age must stay loaded. For Dia, a visit that is not in the read was deleted by the user, so the diff must delete it.

## Decision

`ChromiumBrowser.expiresHistory` tells the source which kind of browser it reads. The source has two catalogs:

- For a browser that removes old history, `historyItems`, `historyVisits` and `searchTerms` have an `expiresAt` field and declare `expiresBy: 'expiresAt'`. Their snapshot diff uses `Retention` with the start of the pass as the horizon. A row that went before its expiry is deleted. A row that went after its expiry stays loaded.
- For a browser that keeps its history, these streams have no `expiresAt` field. Their snapshot diff uses `ClosedWorld`, so each row that went is deleted.

`downloads` and `bookmarks` never expire. Their snapshot diff always uses `ClosedWorld`.

The SDK `@eltjs/sdk-chromium-history` calculates `expiresAt` to the millisecond, because `expiresBy` compares the time as text with a horizon to the millisecond. A row with no time, such as a search whose URL is gone, has an expiry in 1601, so it is already expired.

## Consequences

- The catalog of a source depends on its browser. All sources of browsers of one kind share one catalog.
- A field that has no meaning for a browser is not in its streams. A Dia import has no `expiresAt` column.
- A user who removes a Chrome visit after its expiry, but before Chromium removes it, gets a row that stays loaded. Chromium removes such a row in the next expiry run anyway.
