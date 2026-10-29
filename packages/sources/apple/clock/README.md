# @workspace/source-apple-clock

An ELT source for the Clock app: alarms, timers, recent timer durations, sounds, world clocks, stopwatches and laps, and three regional and diagnostic tables. It reads three stores on this Mac: the MobileTimer database, the city preferences and the stopwatch preferences. It does not write, it does not start Clock, and it does not use the network.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md). The decisions are in [docs/adr](./docs/adr).

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

To read copies of the stores, give a `ClockLocation` (`{ database, cities, stopwatches }`, from `@workspace/sdk-apple-clock/clock-store`) to the constructor. `Pipeline.watch()` watches the source. Context Compiler's `connector-apple-clock` imports all ten streams, with no account, collection, date-range or attachment selection.

## Stores and access

`@workspace/sdk-apple-clock/clock-store` reads three local stores:

| Store                 | Location relative to the home folder                                                      | Streams                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| MobileTimer database  | `Library/Group Containers/group.com.apple.mobiletimerd/local.sqlite`                      | alarms, timers, timer durations, sounds, calendar releases, makeup days, reports |
| City preferences      | `Library/Containers/com.apple.clock/Data/Library/Preferences/com.apple.mobiletimer.plist` | world clocks                                                                     |
| Stopwatch preferences | `Library/Preferences/com.apple.mobiletimerd.plist`                                        | stopwatches and laps                                                             |

The SDK owns the locations, the read-only transactions, the decoding of property lists and archives, the access and schema errors, and the version probes. The source owns the stream schemas, the snapshot comparison, and the choice of streams to refresh.

- A run reads only the stores of the selected streams.
- All database streams read in one SQLite transaction, which includes the WAL commits. The two preference files are separate snapshots.
- A store that fails fails only its own streams. The other streams continue.
- A missing database or a file that the process cannot read gives `ClockUnavailableError`, which is a configuration failure.
- A database without a column that the source reads gives `MissingColumnsError`.
- A property-list value that is not correct stays an error. It never becomes an empty snapshot.
- A preference file with no saved cities, or with no stopwatch collection, has no saved objects. A missing file is an error, not an empty store.

Open Clock one time to make its stores. Clock does not have to stay open. macOS protects the database and the city preferences. When access fails, the host tells the user about Full Disk Access.

On macOS 27, a launchd probe that the user approved ran outside the host that has access. The probe got SQLite `authorization denied` for the database and a permission error for the city preferences. It could read the stopwatch preferences. The host with access read all three stores. This shows the access boundary on the examined Mac. It does not show that Full Disk Access is the only grant with which macOS lets a process read the data of another app.

## Streams and keys

| Stream             | Key, and the stored facts                                                                                                                                                                                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `alarms`           | Native UUID. Title, enabled, local hour, minute and date components, repeat bitmask, snooze settings, sleep flags, coordination, silent-mode and dismissal codes, fire, dismiss, snooze and modification dates, sound relation, Siri context. |
| `timers`           | Native UUID. Title, state code, duration in seconds, sound, URL, fire, dismiss and modification dates, the saved fire-time anchor or the remaining seconds, the full keyed fire-time archive as JSON, Siri and timer contexts.                |
| `timerDurations`   | Core Data row ID. Title and duration of a recent or saved timer, favorite, latest and valid-recent flags, modification date and sound.                                                                                                        |
| `sounds`           | Core Data row ID. Sound type, volume, tone and vibration identifiers, the exact signed 64-bit media-library identifier.                                                                                                                       |
| `calendarReleases` | Core Data row ID. Region, year, release date and check date of a regional calendar release.                                                                                                                                                   |
| `makeupDays`       | Core Data row ID. Stored date, type code, calendar-release relation.                                                                                                                                                                          |
| `reports`          | Core Data row ID. Stored date and Apple's concerns code. The source does not guess the meaning of the code.                                                                                                                                   |
| `worldClocks`      | Position in the saved list. City identifier, names and country overrides, coordinates, time zone, country and language codes, presentation flags and stored type.                                                                             |
| `stopwatches`      | Native identifier. Title, state code, the saved current interval, offset, total of completed laps, and start-date anchor.                                                                                                                     |
| `stopwatchLaps`    | Stopwatch identifier and zero-based position. The stored duration in seconds of each completed lap.                                                                                                                                           |

- Alarms and timers use native UUIDs in upper case, decoded from their 16-byte fields.
- Related rows use exact text IDs. `soundId` and `calendarReleaseId` join their parent tables.
- World clocks use the position as key, because Clock lets a city repeat, and the order is part of the saved list.
- The lap positions belong to the current stopwatch. A reset of the stopwatch removes its laps.

## Values

- Dates are UTC strings with six fractional digits. Core Data dates and native or archived plist dates keep their original seconds since 2001 until `referenceDateInstant` of `@workspace/codec-apple-reference-date` formats them. Thus the millisecond `Date` of JavaScript does not round away the fraction. `codec-plist` gives `PlistDate.referenceSeconds` to consumers that need this precision, and the value still acts as a normal `Date`.
- Large media IDs are strings with `format: int64`.
- Optional values stay null. Opaque Siri and timer context bytes are base64.
- `fireTime` keeps the original keyed archive as JSON, with its references and the numeric `NS.time`.
- Raw codes stay as they are. The examined alarm used bit 0 for Monday and nine snooze minutes. The examined timer states were 1 stopped, 2 paused and 3 running. The examined stopwatch states were 0 reset and 1 stopped.
- No value changes only because a reader runs again. No countdown or elapsed time is calculated. A running timer gives its saved deadline, a paused timer its saved remaining seconds, and a stopwatch its stored anchors and intervals.
- A world clock gives the saved city configuration. It does not give the wall-clock time on the screen, or a sunrise or sunset calculation.

## Changes, deletions and history

Each stream supports full refresh and snapshot incremental. An incremental copy uses `append_dedup`, a checkpoint store and the key of the stream, with no cursor field. It scans the full local contents of each selected stream, writes only new and changed rows, deletes the keys that are gone, and saves the new snapshot. The scan and checkpoint costs increase with the stored rows. No sample, date window, cap or pagination applies. A full refresh replaces its output with the current full scan. A failure keeps the rows and the checkpoint of the last successful run.

Clock keeps mostly the current state:

- Timer durations keep some history. When the probe removed a duration from Recents, Clock set `validRecent` to false and kept the row, with `latest` true. That row still loads.
- The fire and dismiss dates of alarms and timers tell about the stored object. They are not a full log of events.
- The stopwatch preferences hold only the current stopwatch and its completed laps. A reset removed the lap. A full inspection of the local stores found no kept session history.
- The `analytics.sqlite` beside the database had the same model, but each entity was empty, and each `Z_PRIMARYKEY.Z_MAX` was zero. The source does not use it as a history source.
- The `ZAKCD*` entities hold the AlarmKit alarms of other apps, not the objects of Clock. The source does not read them.

A watch makes its version probes before its first check, and the first check names each selected stream. Each second, the database probe checks `PRAGMA data_version`, and the preference probes compare the inode, the size and the modification time in nanoseconds, to see a file that is replaced in one step. A missing preference file is a version too. The watch gives only the selected streams of the stores that changed, and the pipeline reads those streams again. When the watch stops, it stops the interval and closes the SQLite connection. No subscription to a private daemon is necessary.

## Limitations

- Every stream is a snapshot stream. Each run reads all of the stores that the selected streams use. A record that is no longer in its store is deleted from the destination.
- Clock keeps the current state, not a log of events. A timer gives its saved deadline or remaining seconds, not a countdown. A world clock gives the saved city, not the current time.
- When you reset a stopwatch, its laps go away. The stores keep no history of stopwatch sessions.
- When you remove a recent timer, its stored duration can stay with `validRecent` false.
- `calendarReleases`, `makeupDays` and `reports` are not verified with real data, because they were empty on the examined Mac.

## Live checks

Checked on 2026-10-11 with macOS 27.0 (26A428), Clock 1.1 (62) and Node 26.10.0.

- The probe examined the scripting support of Clock, its app intents, its URL behavior, the MobileTimer runtime declarations and `MobileTimer.mom`, both full SQLite stores, and the preferences of Clock and `mobiletimerd`. Clock has no scripting dictionary (`sdef` error -192). From a normal process, the reads of `MTAlarmManager`, `MTTimerManager` and `MTStopwatchManager` gave `NSCocoaErrorDomain` 4097 for their `mobiletimerd` services. Clock has a private `mobiletimerd` entitlement. The app intents operate on objects, but they did not give a full read of the data or its history. The direct read of the stores was the full snapshot path that worked.
- The probe made an alarm, a timer, a city and a stopwatch lap through Clock, and it kept the user's objects. The Context Compiler CLI imported 1 alarm, 2 timers (with the default timer that was there before), 1 timer-duration row, 4 sounds, 6 world clocks, 1 stopwatch and 1 lap, and the three empty auxiliary streams. A second sync with no changes wrote and deleted zero rows. An edit of the alarm title wrote one alarm only.
- The probe removed the alarm, the timer, the city and the lap through Clock, and it reset the stopwatch, which was empty before. The next sync deleted the alarm, the timer, the city, the lap and a sound that no row referred to. It updated the reset stopwatch and the duration that became not valid. The sync after it wrote and deleted zero rows in all ten streams. All ten `stream_status` records were successful, and all ten checkpoint bindings and states were valid JSON. The reader views and the ten saved checkpoints were examined. The five cities and the stopped default timer from before stayed. Clock keeps the not-valid recent duration after it is removed from the screen.
- With Clock closed, the plugin host classes of Context Compiler (`ApplePlugin`, the connector discovery and `importPending`) imported all ten streams from the native stores, into temporary settings and output. A second start left the successful pass unchanged. The settings of the installed plugin did not change. The bundle and setup integration suite of the host and its native-settings suite also passed.
- After the user approved it, the three read-only store checks ran as the temporary launchd job `com.contextcompiler.clock-read-probe`, outside the host that has access. Launchd ran the script three times before it was removed, with the same results each time. The database and city reads failed, and the stopwatch preferences passed validation. The same checks passed from the host that has access. The probe processes stopped, and the launchd job was removed. No privacy setting and no native record changed.
- The tests use synthetic stores with the native shape, through the public source and a real pipeline and SQLite destination. They cover failed and malformed stores that keep their rows and checkpoints while the other stores import, exact values (IDs, relations, dates finer than a millisecond, the original timer archive), unchanged, update and delete behavior, a full refresh again after changes, and a watch that refreshes only the streams of the changed store and stops on cancellation. A separate read-only live test compares the database and preference counts with this Mac. It skips only when access is not available. On the examined Mac it ran and did not skip.
- A mutation run broke the source on purpose, and the tests caught each break: failed preference reads that become empty arrays, a saved timer archive that becomes null, each selected stream that wakes for a change of any store, and a read of only the running timers.

Not verified with real data:

- `calendarReleases`, `makeupDays` and `reports` were empty in both full stores. In this region, Clock has no operation to make these regional and diagnostic records. Their shapes and relations come from the model that Apple ships, and synthetic records test them.
- Stopwatch session history, and history that only private APIs give: the probe found no kept session store and no manager history API that it could read. This does not show that other macOS versions keep no such history.
