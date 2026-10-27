# @workspace/source-apple-activity

An ELT source for the activity that macOS records about the user: app focus, Screen Time usage, web usage, media, Focus modes, notifications, Bluetooth connections and more. It reads Biome's streams in `~/Library/Biome`, `knowledgeC.db` in `~/Library/Application Support/Knowledge` and Biome's `sync.db`, on this Mac. It does not use the network, and no app has to be open.

```ts
import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';
import { AppleActivitySource } from '@workspace/source-apple-activity/apple-activity-source';

const source = new AppleActivitySource();
const destination = new SQLiteDestination({ path: './activity.sqlite' });

await new Pipeline({
  history: new SQLiteSyncHistory(),
  connections: [
    new Connection({
      name: 'apple-activity',
      source,
      destination,
      checkpoints: new SQLiteCheckpointStore({
        path: './activity-state.sqlite',
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

| Stream                   | Upstream                              | Kept     |
| ------------------------ | ------------------------------------- | -------- |
| `appFocus`               | Biome `App.InFocus`                   | 28 days  |
| `screenTimeAppUsage`     | Biome `ScreenTime.AppUsage`           | 28 days  |
| `appMenuItems`           | Biome `App.MenuItem`                  | 28 days  |
| `appIntents`             | Biome `App.Intent`                    | 28 days  |
| `webUsage`               | Biome `App.WebUsage`                  | 28 days  |
| `safariNavigations`      | Biome `Safari.Navigations`            | 28 days  |
| `documentInteractions`   | Biome `App.DocumentInteraction`       | 28 days  |
| `mediaUsage`             | Biome `App.MediaUsage`                | 28 days  |
| `nowPlaying`             | Biome `Media.NowPlaying`              | 28 days  |
| `focusModes`             | Biome `UserFocus.ComputedMode`        | 28 days  |
| `focusSuggestions`       | Biome `UserFocus.InferredMode`        | 28 days  |
| `notificationUsage`      | Biome `Notification.Usage`            | 28 days  |
| `notificationDeliveries` | Biome `Notification.Delivery`         | 3 days   |
| `bluetoothConnections`   | Biome `Device.Wireless.Bluetooth`     | 28 days  |
| `screenshots`            | Biome `Screenshots.Screenshot`        | 1 day    |
| `knowledgeIntents`       | knowledgeC `/app/intents`             | 28 days  |
| `displayBacklight`       | knowledgeC `/display/isBacklit`       | 28 days  |
| `discoverabilitySignals` | knowledgeC `/discoverability/signals` | 730 days |
| `devices`                | `sync.db` `DevicePeer`                | current  |

"Kept" is the maximum time that macOS keeps a record. A start and its end are two different records.

Access: every store needs Full Disk Access for the app that runs the pipeline. A store that the source cannot open fails only its own streams, with `BiomeUnavailableError` or `KnowledgeUnavailableError`. Reading without Full Disk Access is not verified.

Limitations:

- macOS deletes records after their maximum age. The destination keeps the rows of those records. Thus these rows are only in the destination: if you clear a copy or do a full-refresh overwrite, you lose them permanently.
- If a record goes away before its maximum age, the source deletes its row. For example, when you clear the Safari history, the `webUsage` and `safariNavigations` rows go away.
- Each Biome stream also has a maximum number of records. A stream that gets to this limit loses records before their maximum age, and the source deletes their rows.
- A watch examines the stores every minute (`pollIntervalMs`).

See [docs/reference.md](../../../../docs/reference.md#apple-activity).
