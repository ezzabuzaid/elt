# Each stream is read completely on each run

A Mac keeps no Health store. macOS 27 has HealthKit, but `isHealthDataAvailable` is false, and the Health data in iCloud has end-to-end encryption. Thus Apple Health gets to the warehouse through the Google Health iPhone app, which relays it into Google Health (ad616615).

Google Health keeps no change record that a source can read. `list` filters only on when a point occurred, most points have no id and no update time, and only a public webhook gets deletions. Thus each stream is Full Refresh | Overwrite: each run reads each stream completely, and the copy replaces the table (ad616615). Google answers a daily type for each date, also a date with no data. Thus a daily type starts at the `membershipStartDate` of the profile (ad616615).

## Considered Options

- **An incremental read on the time of each point.** It does not find edits or deletions, because points have no update time and Google sends deletions only to a public webhook.
- **Full Refresh | Overwrite.** This option was selected.

## Consequences

- An edit or a deletion upstream shows after the next run.
- A failed read keeps the previous rows, because elt loads a full refresh into a hidden table and replaces the old table only when the stream ends with no failure.
- Each run sends many requests. The SDK keeps them below 300 each minute for each user.
- The streams that Google reconciles across devices are not read (#2642). Apple activity rings are not in Google Health (#2633).

Sources: commit ad616615; backlog #2642 and #2633.
