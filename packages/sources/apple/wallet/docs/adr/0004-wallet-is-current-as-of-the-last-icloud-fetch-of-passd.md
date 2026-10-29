# Wallet is current as of the last iCloud fetch of passd

A change on the iPhone gets to this Mac only when passd fetches the `passes` zone of Wallet from iCloud. passd does this one time each day (`ScheduledActivities.archive`, repeat interval 86,400 s). On 2026-10-10, a pass removed on the iPhone was still in the store of this Mac 45 minutes later. Before this decision, the source said that it was current at each read, so the `current_as_of` of the destination said "now" for data up to one day old.

Thus `currentAsOf` gives the earliest `fetch_timestamp` of the `passes` zones in `cloud_store_zone`, or null when passd never fetched them.

## Considered Options

- **Current at each read (null).** It claims "now" for data that can be one day old.
- **The latest fetch.** One zone that is up to date hides an older zone.
- **The earliest fetch among the `passes` zones.** This option was selected.

## Consequences

- A reader sees how old the Wallet data can be.
- A pass removed on the iPhone stays in the destination until the next fetch (backlog item 2547).

Sources: commit 83242264, backlog items 2819 and 2547.
