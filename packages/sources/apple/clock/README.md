# @workspace/source-apple-clock

An ELT source for the Clock app: alarms, timers, recent timer durations, sounds, world clocks, stopwatches and laps, and three regional and diagnostic tables. It reads three files on this Mac: the MobileTimer database, Clock's city preferences and the preferences of `mobiletimerd`. It does not write, start Clock or use the network.

```ts
import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';
import { AppleClockSource } from '@workspace/source-apple-clock/apple-clock-source';

const source = new AppleClockSource();
const destination = new SQLiteDestination({ path: './clock.sqlite' });

await new Pipeline({
  history: new SQLiteSyncHistory(),
  connections: [
    new Connection({
      name: 'apple-clock',
      source,
      destination,
      checkpoints: new SQLiteCheckpointStore({ path: './clock-state.sqlite' }),
      steps: [source.alarms, source.timers, source.worldClocks].map(
        (stream) =>
          new Copy(stream, destination.table(stream.name), {
            id: stream.name,
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          }),
      ),
    }),
  ],
}).run();
```

| Stream             | Store                    | Key                               |
| ------------------ | ------------------------ | --------------------------------- |
| `alarms`           | MobileTimer database     | native UUID                       |
| `timers`           | MobileTimer database     | native UUID                       |
| `timerDurations`   | MobileTimer database     | Core Data row ID                  |
| `sounds`           | MobileTimer database     | Core Data row ID                  |
| `calendarReleases` | MobileTimer database     | Core Data row ID                  |
| `makeupDays`       | MobileTimer database     | Core Data row ID                  |
| `reports`          | MobileTimer database     | Core Data row ID                  |
| `worldClocks`      | Clock city preferences   | position in the saved list        |
| `stopwatches`      | mobiletimerd preferences | native identifier                 |
| `stopwatchLaps`    | mobiletimerd preferences | stopwatch identifier and position |

Access: open Clock one time to make its stores. macOS protects the database and the city preferences. A process without access, such as a process without Full Disk Access, cannot read them. A missing or unreadable store fails only its own streams, with `ClockUnavailableError`. A database without a column that the source reads fails with `ClockSchemaError`.

Limitations:

- Every stream is a snapshot stream. Each run reads all of the stores that the selected streams use. A record that is no longer in its store is deleted from the destination.
- Clock keeps the current state, not a log of events. A timer gives its saved deadline or remaining seconds, not a countdown. A world clock gives the saved city, not the current time.
- When you reset a stopwatch, its laps go away. The stores keep no history of stopwatch sessions.
- `calendarReleases`, `makeupDays` and `reports` are not verified with real data, because they were empty on the examined Mac.

See [docs/reference.md](../../../../docs/reference.md#apple-clock).
