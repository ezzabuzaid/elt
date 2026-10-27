# @workspace/source-microsoft-teams

An ELT source for the data that the new Microsoft Teams app (`com.microsoft.teams2`) keeps on this Mac. It reads the IndexedDB of the app's WebView profile `WV2Profile_tfw` with the `@workspace/sdk-microsoft-teams` SDK. It uses no Microsoft Graph, no token and no network.

```ts
import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';
import { TeamsSource } from '@workspace/source-microsoft-teams/teams-source';

const source = new TeamsSource();
const destination = new SQLiteDestination({ path: './teams.sqlite' });

await new Pipeline({
  history: new SQLiteSyncHistory(),
  connections: [
    new Connection({
      name: 'teams',
      source,
      destination,
      checkpoints: new SQLiteCheckpointStore({ path: './teams-state.sqlite' }),
      steps: [source.conversations, source.people, source.messages].map(
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

## Streams

| Group         | Streams                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------- |
| Accounts      | `accounts`, `people`, `installedApps`, `searches`                                                                   |
| Conversations | `conversations`, `conversationMembers`, `pins`, `folders`, `folderConversations`                                    |
| Messages      | `messages`, `messageReactions`, `messageMentions`, `messageFiles`, `messageLinks`, `messageQuotes`, `savedMessages` |
| Calls         | `callLogs`, `callParticipants`                                                                                      |
| Activity      | `activities`                                                                                                        |
| Calendar      | `meetings`, `meetingAttendees`                                                                                      |

Every key has `accountId`, the user's Entra object ID.

## Access

The app's container needs Full Disk Access. Without the grant, or without the app, every stream fails with `TeamsUnavailableError`, which names the grant. A record in a shape that the reader does not know fails every stream with `TeamsFormatError`, which names the database, object store, key and field.

## Limitations

- The app keeps every conversation, but only the messages that it loaded. Older history gets to the import only when the app loads it.
- The app records the span of each conversation that it holds. The source deletes a message only when the message is gone from a span that the app holds. A message out of all spans stays.
- `people`, `meetings` and `searches` delete nothing. The app keeps only recent data for them.
- An account that the user signed out of keeps all its rows.
- The source reads only work and school accounts. It does not read personal Microsoft accounts (`teams.live.com`).
- Files stay in OneDrive or SharePoint. `messageFiles` holds their metadata and addresses only.
- After a change of the Teams app language, the first import does not read history that only the old cache holds.

See [docs/reference.md](../../../../docs/reference.md#microsoft-teams).
