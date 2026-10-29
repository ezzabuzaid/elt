# Child rows are numbered in content order

The key of a child row (an attendee, an alarm, an ICS component) is the ID of its parent and its position. EventKit gives the attendees and alarms of an item, and its ICS export gives the exceptions of a series and their alarms, in a different order in each process. With the order of EventKit, each run wrote approximately 7,000 positional rows again that did not change.

Thus the store and the source number children in content order:

- attendees by URL, name, role and type. Status is not in the key, because a reply changes it. Thus a reply changes its row in place.
- alarms in firing order: relative alarms by offset, then absolute alarms by date, then by their other fields.
- ICS components by their content. Properties and parameters keep the order of the export, which is stable.

The sort compares each part of a key in turn: null first, numbers by value, strings by code point. An earlier sort compared the JSON text of each key. It numbered alarms of 10, 30 and 60 minutes before the start in the order -1800, -3600, -600.

## Considered Options

- **The order of EventKit.** Each run then writes unchanged rows again.
- **Positions in content order.** This option was selected.

## Consequences

- A second run with no changes writes nothing.
- A new or changed child can renumber its siblings.
- The Reminders source uses the same order for its attendees and alarms.

## Sources

- 700541fa: children are numbered in content order, and a second unchanged run writes nothing (verified live).
- 78290160 (#2136): number the alarms of an item in the order they fire; sort keys compare part by part.
