# History expires by the history setting of Safari

Safari removes the visits that are older than its history setting, General › Remove history items. It writes no tombstone for them. A snapshot diff deletes each key that is not in the read. Thus, without more information, the diff deletes the rows of each visit that Safari expired, and the destination loses the old history.

elt lets a stream declare `expiresBy`, a date-time field. The diff then gets a horizon. A vanished key whose `expiresBy` is before the horizon expired: it leaves the snapshot without a DELETE, and its row stays. Each other vanished key is deleted.

Thus `historyVisits` expires by `visitedAt`, and `historyItems` expires by `lastVisitedAt`, the time of the latest visit of a URL. The horizon is the start of the read less `HistoryAgeInDaysLimit` days, plus one hour for a daylight saving change. Safari.framework on macOS 27 shows what that key holds:

- Remove history items › Manually stores 365000, not 0.
- Safari reads a stored value below 1 as one day.
- While the key is not set, Safari keeps 365 days.

## Considered Options

- **Delete each vanished key.** The destination then loses each visit that Safari expires.
- **Delete no vanished key.** A visit that the user removes then stays in the destination.
- **Expire by the history setting of Safari.** This option was selected.

## Consequences

- A visit or URL that disappeared before the horizon keeps its row. A visit or URL that was removed after the horizon is deleted.
- Tags and tombstones do not expire with the history setting, so the diff deletes them as before.
- Safari also keeps no more than 100,000 URLs. Its daily maintenance drops the URLs with the oldest last visit, also inside the horizon. Past that limit, the rows of those URLs and their visits are deleted, not expired (#2247, open).
- elt now gives the horizon as a deletion policy: the source passes `Retention(horizon)` for an expiring stream and `ClosedWorld` for the others.

## Sources

- f9cc0a57: keep rows that an upstream expires; Safari `historyVisits` and `historyItems` expire by `HistoryAgeInDaysLimit`, one year while it is not set.
- 902d484c: read a history limit below one day as one day, as Safari does; Manually stores 365000; Safari keeps at most 100,000 URLs.
- 3e70cef1: a snapshot diff deletes only the vanished records that its read covers; expiry is one kind of coverage.
- 01206d6d: a deletion policy judges each vanished key.
- #2247: rows of URLs that Safari drops past its 100,000-URL cap are deleted, not expired.
