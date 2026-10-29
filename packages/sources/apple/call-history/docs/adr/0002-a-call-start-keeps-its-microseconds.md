# A call start keeps its microseconds

Core Data keeps a date as seconds since 2001-01-01 in a double. On 2026-10-06, 2,121 of 2,123 call start times held a fraction finer than a millisecond. A JavaScript `Date` keeps only milliseconds, so it changes these values, and nothing reports it.

Thus `startedAt` is a `date-time` with `precision` 6. The SDK writes it to the microsecond, and not through a `Date`. The scope of the source compares dates with three digits, and a time with six digits sorts before the same time with three digits. Thus the scan cuts `startedAt` to the millisecond before it compares it with `startAt` and `endAt`.

## Considered Options

- **Write the time through a `Date`.** It rounds the time to the millisecond.
- **Write the time to the microsecond, and cut it only for the comparison with the scope.** This option was selected.

## Consequences

- A call loads with the time that the store holds.
- Each call is on the same side of a scope boundary as its time cut to the millisecond.

Sources: commit 0e07d451.
