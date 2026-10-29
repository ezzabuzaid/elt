# @workspace/source-apple-activity

An ELT source for the activity that macOS records about the user: app focus, Screen Time usage, web usage, media, Focus modes, notifications, Bluetooth connections and more. It reads the Biome streams in `~/Library/Biome`, `knowledgeC.db` in `~/Library/Application Support/Knowledge`, and Biome's `sync.db`, on this Mac. It does not use the network, and no app has to be open.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md), and the glossary of [elt](../../../elt/CONTEXT.md) for the words of all of elt.

```ts
import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';
import { AppleActivitySource } from '@workspace/source-apple-activity/apple-activity-source';

const source = new AppleActivitySource(); // ~/Library/Biome and knowledgeC.db
const destination = new SQLiteDestination({
  path: './outputs/activity.sqlite',
});

await new Pipeline({
  history: new SQLiteSyncHistory(),
  connections: [
    new Connection({
      name: 'apple-activity',
      source,
      destination,
      checkpoints: new SQLiteCheckpointStore({
        path: './outputs/activity-state.sqlite',
      }),
      steps: [source.appFocus, source.webUsage, source.devices].map(
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

The constructor takes `{ biome, knowledge, pollIntervalMs }`: the Biome folder, the path of `knowledgeC.db`, and the poll interval of a watch (one minute when you do not give it).

A Context Compiler import loads every stream incrementally into its `data.sqlite`. Readers use its `<snake_stream>` views.

## Stores

| Store                              | Where                                         | Streams                                                          |
| ---------------------------------- | --------------------------------------------- | ---------------------------------------------------------------- |
| Biome streams (SEGB segment files) | `~/Library/Biome/streams/restricted/<Stream>` | the fifteen streams below that have a Biome stream as upstream   |
| `knowledgeC.db` (Core Data, WAL)   | `~/Library/Application Support/Knowledge`     | `knowledgeIntents`, `displayBacklight`, `discoverabilitySignals` |
| `sync.db` (SQLite, WAL)            | `~/Library/Biome/sync`                        | `devices`                                                        |

The SDK `sdk-apple-biome` reads the Biome streams and `sync.db`. The SDK `sdk-apple-knowledge` reads knowledgeC. A run opens only the stores that its selected streams read. It pins each database in one read transaction, and it opens each database read-only, never as `immutable`.

A store that the source cannot open fails only its own streams, with `BiomeUnavailableError` or `KnowledgeUnavailableError`. A knowledgeC layout that does not have a column fails only the streams that read that column, with `MissingColumnsError`.

## Access

Every store needs [Full Disk Access](../messages/README.md) for the app that runs the pipeline. With it, a terminal read all 818 Biome files on 2026-10-05. Reading Biome without it is not verified, because that needs the grant removed. The system Biome in `/private/var/db/biome` belongs to `_biome`, and the source does not read it.

## Streams

| Stream                   | Upstream                              | Kept     | One record for each                                                           |
| ------------------------ | ------------------------------------- | -------- | ----------------------------------------------------------------------------- |
| `appFocus`               | Biome `App.InFocus`                   | 28 days  | app that comes into or leaves the foreground, on this Mac and synced devices  |
| `screenTimeAppUsage`     | Biome `ScreenTime.AppUsage`           | 28 days  | start or end of usage that Screen Time counts, without the system interface   |
| `appMenuItems`           | Biome `App.MenuItem`                  | 28 days  | use of the menu bar of an app (which app, not which item)                     |
| `appIntents`             | Biome `App.Intent`                    | 28 days  | interaction that an app donated, with its decoded `INInteraction`             |
| `webUsage`               | Biome `App.WebUsage`                  | 28 days  | change of the usage of a page that Screen Time counts                         |
| `safariNavigations`      | Biome `Safari.Navigations`            | 28 days  | navigation that Safari reports, with its time rounded up to the half hour     |
| `documentInteractions`   | Biome `App.DocumentInteraction`       | 28 days  | document that an app opened or used                                           |
| `mediaUsage`             | Biome `App.MediaUsage`                | 28 days  | start or stop of media that an app played                                     |
| `nowPlaying`             | Biome `Media.NowPlaying`              | 28 days  | Now Playing change, on this Mac and synced devices                            |
| `focusModes`             | Biome `UserFocus.ComputedMode`        | 28 days  | Focus that turns on or off                                                    |
| `focusSuggestions`       | Biome `UserFocus.InferredMode`        | 28 days  | start or end of a Focus that the system suggested                             |
| `notificationUsage`      | Biome `Notification.Usage`            | 28 days  | notification event (no title or body)                                         |
| `notificationDeliveries` | Biome `Notification.Delivery`         | 3 days   | delivered notification                                                        |
| `bluetoothConnections`   | Biome `Device.Wireless.Bluetooth`     | 28 days  | Bluetooth device that connects or disconnects, on this Mac and synced devices |
| `screenshots`            | Biome `Screenshots.Screenshot`        | 1 day    | screenshot                                                                    |
| `knowledgeIntents`       | knowledgeC `/app/intents`             | 28 days  | app interaction; on a Mac they come from the iPhone through knowledge sync    |
| `displayBacklight`       | knowledgeC `/display/isBacklit`       | 28 days  | time span when the display stayed lit or dark                                 |
| `discoverabilitySignals` | knowledgeC `/discoverability/signals` | 730 days | feature-discovery signal that macOS uses to time its tips                     |
| `devices`                | `sync.db` `DevicePeer`                | current  | device that Biome syncs with, this Mac included                               |

"Kept" is the maximum age of each stream. The BiomeLibrary of macOS compiles it (`storeConfigurationFor<Stream>` builds a `BMPruningPolicy`). No file on disk gives it.

Biome streams have `origin` (`local`, or the identifier of the synced device), `segment`, `slot` and `recordedAt`, the time when Biome wrote the record. Where the record has its own time, it is in `occurredAt`. Some payloads store Unix times, not Mac times. `appIntents` stores the time of the interaction, which can be before its write. A start and its end are two different records. A session goes from a start to the next end of the same app and origin.

The source does not read these:

- knowledgeC's `/app/usage`, `/app/mediaUsage`, `/notification/usage` and `/app/webUsage`. They copy Biome streams: 10,167 of 10,200 `/app/usage` end times agree with `ScreenTime.AppUsage`, and 182 of 182 media records and 4,731 of 4,782 notifications agree. Also, `/app/usage` loses rows irregularly before 28 days.
- Other Biome streams: telemetry (Siri analytics, Lighthouse, IntelligenceFlow), content copies (ProactiveHarvesting, TextUnderstanding), and, by the choice of the user, Siri.Remembers (call and message history synced from an iPhone), Pasteboard, Wallet and Location. Also HomeKit, Messages.Read and Mail.Search.
- Streams with no records on the examined Mac, whose fields cannot be typed: `Safari.PageLoad`, `Screen.Sharing`, `App.Activity`, `Audio.Route` and `App.WebApp.InFocus`.
- Fields that Biome does not name or that the source does not name, for example most fields of `Safari.Navigations`, file bookmark data and constant enums. `payload` holds the protobuf of each record, as base64, as Biome stored it.

## Presets

The Activity connector of Context Compiler has [presets](https://github.com/ezzabuzaid/context-compiler/blob/main/docs/connectors-and-hosts.md) that pair each start with its end:

- `app_focus_sessions` and `screen_time_sessions` go from a start to the next record of the same device. That record is the end of the app, or, when the end is missing, the start of the next app.
- `media_sessions` and `web_visits` pair the records of a playback or a visit by `usageId`. A visit starts at usage state 2 and ends at 1.
- `focus_mode_spans` and `bluetooth_sessions` go from a start to the next record of the same Focus or Bluetooth device, when that record is the end.

Each preset gives `started_at`, `ended_at` and `seconds`. `ended_at` is NULL while the span is open. A focus session counts time in front, not use. On 2026-10-05, the login window held focus for 17–21 hours each night while the Mac was locked, and the face of an Apple Watch held focus for days. Without those two, no device held more than 12.7 hours of app focus in one day.

## Records and identity

A Biome stream folder holds `local/` for this Mac and `remote/<device>/` for each synced device. The `tombstone/` folders next to them hold the deletion log of Biome.

Each file is a preallocated SEGB v2 segment. [The reader of CCL](https://github.com/cclgroupltd/ccl-segb/blob/23c3f7d3d969a79627b738ba0a2486c31d675753/ccl_segb/ccl_segb2.py) and an article of Cellebrite describe the format:

- A 32-byte header. Its int32 at byte 4 counts the slots.
- The records, from byte 32. A CRC-32 and an int32 come before each record.
- Trailer slots of 16 bytes, counted back from the end of the file: slot k is at `size − 16·(k+1)`. A slot holds the end offset of its record, its state (1 written, 3 deleted, 4 empty) and its write time.

Biome never compacts a segment. Thus `(origin, segment, slot)` identifies a record. The codec `codec-segb` (`packages/codecs/segb`) reads the format. `sdk-apple-biome` lists the segments of each stream and decodes the fields of their records. Only a written slot whose CRC agrees is a record: Biome fills a deleted record with zeroes in place, and some slots marked written hold zeroes (240 of them in the files of this Mac).

## Changes, expiry and deletions

A Biome stream diffs one [group](../../../elt/README.md) for each segment. The fingerprint of a group is a hash of the trailer of its segment. Thus a run reads only the segments to which Biome added records or from which it deleted records ([ADR 0002](./docs/adr/0002-a-biome-segment-is-one-group-fingerprinted-by-its-trailer.md)). The size and the modification time cannot do this: Biome writes preallocated files in place, and the modification time was up to 236 hours older than the newest record. The deletion counter of the header cannot do this either: it did not agree with the deleted slots in 9 of 417 files.

Every stream [expires](../../../elt/README.md) by `recordedAt` (`startedAt` for knowledgeC) at its maximum age, less one hour ([ADR 0001](./docs/adr/0001-a-record-older-than-its-maximum-age-expires-and-keeps-its-row.md)). Biome does not prune a record before that age: each of the 18,305 age-pruning tombstones of the week before 2026-10-05 was 28.000–29.03 days after a 28-day record. The sync daemon of Biome also removes synced copies, with an explicit-deletion reason, 28.6–29.0 days after the record. Those copies expire too. A record that goes away before its age is deleted: when the user cleared the Safari history, and when Screen Time ran `delete-web-history`, `webUsage` and `safariNavigations` records only minutes old went away. `devices` diffs as a plain snapshot.

- **Limits:** each stream also has a maximum number of events and a maximum size. `App.InFocus` keeps a maximum of 75,000 records, `Notification.Usage` 30,000, and Bluetooth, Safari navigations and the two Focus streams 10,000. A stream that gets to its maximum prunes records that are younger than its maximum age, and the source deletes their rows (backlog item 2243). The examined Mac held 31,772 `App.InFocus` records. Biome prunes once a day as a maintenance task. Thus records can stay after their maximum age until it runs.
- **Rebuilding:** the rows of records that macOS dropped are only in the destination. If you clear a copy, rebuild the import, or turn the connector off, you lose them permanently. A change of the fields of a stream keeps them ([shape changes](../../../elt/README.md)).
- **Cost:** the first load of this Mac (about 100,000 records) took 4.4 s. A second run with no new records took 0.7 s. The checkpoint store held 12 MB of snapshot state.

## Watching

A watch polls every minute (`pollIntervalMs`). For each selected Biome stream, it reads the list of segments and the hash of each trailer. For knowledgeC and `sync.db`, it reads `data_version`. It wakes only the streams that changed. During a live check of 64 seconds while records came in, `stat` saw no change, FSEvents on the folder reported nothing, and kqueue reported 45 events for `App.InFocus` but none for `ScreenTime.AppUsage`.

## Live checks

Checked live on 2026-10-05 on macOS 27.0 (26A428):

- All 818 Biome files were SEGB v2. `codec-segb` read the 280 segments of every stream, with 447,013 intact, 216,461 deleted and 245 unreadable slots. An independent reader gave the same numbers.
- The field meanings come from the initializer of each Biome event class in the dyld shared cache. Where the data could check it, the order of the arguments agreed with the protobuf field numbers. The fields of `App.MenuItem`, `App.DocumentInteraction`, `Safari.Navigations` and `Notification.Delivery` are named from the data.
- Of 11 remote device folders, only the iPhone wrote in the last week. Its records covered 27.95 days. `sync.db` names no device.
- All `knowledgeIntents` rows came from the iPhone through knowledge sync. `discoverabilitySignals` went back to 2025-02.
- A load through the Context Compiler CLI read 19 streams in 6 s. A second load wrote nothing.
- On 2026-10-12, 3 of 307 `App.Intent` records held no verb (field 5) and no group (field 12). Each was the `MTCreateAlarmIntent` of Clock, with intent type 2. Their `intentVerb` and `groupId` load as NULL. Every SiriKit intent (type 1) held a verb.

Not verified: reading without Full Disk Access (backlog item 2248); what macOS stores for a device of platform 4; streams with no records here.

## Limitations

- macOS deletes records after their maximum age. The destination keeps the rows of those records. Thus these rows are only in the destination: if you clear a copy or do a full-refresh overwrite, you lose them permanently.
- If a record goes away before its maximum age, the source deletes its row. For example, when you clear the Safari history, the `webUsage` and `safariNavigations` rows go away.
- A Biome stream that gets to its maximum number of records loses records before their maximum age, and the source deletes their rows.
- A watch examines the stores every minute (`pollIntervalMs`).

## Decisions

- [ADR 0001](./docs/adr/0001-a-record-older-than-its-maximum-age-expires-and-keeps-its-row.md): a record older than its maximum age expires and keeps its row.
- [ADR 0002](./docs/adr/0002-a-biome-segment-is-one-group-fingerprinted-by-its-trailer.md): a Biome segment is one group, fingerprinted by its trailer.

## Development

Run the commands from the workspace root.

```sh
npx nx run source-apple-activity:test        # builds, then runs src/*.test.ts
npx nx run source-apple-activity:typecheck   # formats, lints, then type checks
```
