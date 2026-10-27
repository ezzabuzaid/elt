# @workspace/source-slack-desktop

An ELT source for the data that the Slack desktop app keeps on this Mac. It reads the app's own IndexedDB store with the `@workspace/sdk-slack-desktop` SDK. It uses no Slack API, no token and no network.

```ts
import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';
import { SlackDesktopSource } from '@workspace/source-slack-desktop/slack-desktop-source';

const source = new SlackDesktopSource();
const destination = new SQLiteDestination({ path: './slack.sqlite' });

await new Pipeline({
  history: new SQLiteSyncHistory(),
  connections: [
    new Connection({
      name: 'slack',
      source,
      destination,
      checkpoints: new SQLiteCheckpointStore({ path: './slack-state.sqlite' }),
      steps: [source.channels, source.members, source.messages].map(
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

Slack has two builds for macOS. The build from slack.com keeps its store in `~/Library/Application Support/Slack`. The Mac App Store build keeps it in `~/Library/Containers/com.tinyspeck.slackmacgap/Data/Library/Application Support/Slack`. The source finds the store when you make it. When both folders have a store, it uses the store whose files changed last. To choose a folder, give it to the constructor: `new SlackDesktopSource(directory)`.

## Streams

| Group         | Streams                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------- |
| Workspaces    | `workspaces`, `members`, `bots`, `apps`, `preferences`, `userGroupMemberships`                           |
| Conversations | `channels`, `channelMembers`, `pins`, `channelSections`, `channelSectionChannels`, `threadSubscriptions` |
| Messages      | `messages`, `threadReplies`, `messageAttachments`, `messageReactions`, `messageFiles`                    |
| Files         | `files`, `fileShares`, `listRecords`, `downloads`                                                        |

Every key has `workspaceId`.

## Access

The Mac App Store build's container needs Full Disk Access. Without the grant, or without the app, every stream fails with `SlackDesktopUnavailableError`, which names the grant. Bytes in a format that the reader does not know fail with `SlackDesktopFormatError`, which names the record and the field. In both cases, the source deletes nothing.

## Limitations

- The app keeps every conversation and member that it knows, but only the messages that it loaded. Older history gets to the import only when the app loads it.
- The app records which ranges of messages it holds. The source deletes a message only when the message is gone from a range that the app holds. A message out of all ranges stays.
- `threadReplies` deletes nothing. A reply stays after the app drops it.
- The app keeps no file contents, so `files` holds metadata only. `downloads` has the file while it is still at its download path.
- A workspace that the store no longer holds, such as a workspace that the user signed out of, keeps all its rows.

See [docs/reference.md](../../../../docs/reference.md#slack).
