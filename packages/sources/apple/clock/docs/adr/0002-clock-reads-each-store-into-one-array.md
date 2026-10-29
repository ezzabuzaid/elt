# Clock reads each store into one array

The Apple SDKs read whole tables with `.all()`, so the memory of a pass increased with the store. Backlog #2567 measured this on 2026-10-11, and the SDKs then streamed their whole-table reads, one record at a time.

The stores of Clock hold a small number of alarms, timers and stopwatches, and they do not increase with use. Thus the Clock SDK keeps its reads as arrays. The rule of the `add-elt-source` skill names Clock as an example of a table that cannot increase.

## Considered Options

- **Stream each read, as the stores that increase do.** This adds code for no saving of memory.
- **Keep each read as an array.** This option was selected.

## Consequences

- A read of Clock is simple, and its memory stays small.
- If Clock starts to keep a history that increases with use, its reads must stream.

## Sources

Commit 3b11229d, and backlog #2567.
