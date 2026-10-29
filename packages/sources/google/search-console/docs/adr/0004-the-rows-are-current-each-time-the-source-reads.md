# The rows are current each time the source reads

Each source tells how current each stream of its upstream is, with `currentAsOf(stream)`. Null tells that the upstream is current each time the source reads it. A date limits `current_as_of` (#2819). Backlog #2819 asked if Search Console must give a date, because Google does not finalize the data of the last two or three days. The candidate answer was the newest final date that the API reports.

The decision is null. The source reads with `dataState: 'ALL'`, so it also reads the days that Google can still restate, and it marks each row `settled` or not. Thus the rows agree with Google each time the source reads. The warehouse showed this: it had rows through the day before, and 12 of them were not settled (#2819, 83242264).

## Considered Options

- **The newest final date that the API reports.** Then `current_as_of` tells a time that is older than the rows that the source loaded.
- **Null, and a `settled` flag on each row.** This option was selected.

## Consequences

- `currentAsOf` gives null for each stream.
- A reader that wants only final data selects the rows where `settled` is true.

Sources: commit 83242264; backlog #2819.
