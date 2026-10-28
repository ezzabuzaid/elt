# @workspace/source-whatsapp-desktop

An ELT source for the data that WhatsApp for Mac keeps on this Mac. It reads the SQLite stores in the group container `~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared` with the `@workspace/sdk-whatsapp-desktop` SDK. It uses no WhatsApp server, no session and no network.

```ts
import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';
import { WhatsAppDesktopSource } from '@workspace/source-whatsapp-desktop/whatsapp-desktop-source';

const source = new WhatsAppDesktopSource();
const destination = new SQLiteDestination({ path: './whatsapp.sqlite' });

await new Pipeline({
  history: new SQLiteSyncHistory(),
  connections: [
    new Connection({
      name: 'whatsapp',
      source,
      destination,
      checkpoints: new SQLiteCheckpointStore({
        path: './whatsapp-state.sqlite',
      }),
      steps: [source.chats, source.messages, source.users].map(
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

| Store                              | Streams                                                                                                                                                                                                              |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ChatStorage.sqlite`               | `chats`, `messages`, `messageReceipts`, `messageReactions`, `messageReactionCounts`, `messageDataItems`, `groupMembers`, `groupMembersChanges`, `chatPushConfigs`, `pushNames`, `profilePictures`, `blockedContacts` |
| `ContactsV2.sqlite`                | `contacts`                                                                                                                                                                                                           |
| `LID.sqlite`                       | `users`                                                                                                                                                                                                              |
| `CallHistory.sqlite`               | `calls`, `callParticipants`                                                                                                                                                                                          |
| `ExtChatDB/ExtChatDatabase.sqlite` | `messageAssociations`                                                                                                                                                                                                |
| `Biz/Biz.sqlite`                   | `businessProfiles`, `businessVerifiedNames`, `businessCategories`, `businessHours`, `businessServiceAreas`, `businessBotPrompts`                                                                                     |
| `statusDB/Status.sqlite`           | `statuses`                                                                                                                                                                                                           |
| `Sticker.sqlite`                   | `stickerPacks`, `stickers`                                                                                                                                                                                           |
| `LocalKeyValue.sqlite`             | `privacySettings`, `disappearingModes`, `linkedProfiles`, `changedNumbers`                                                                                                                                           |
| `BackedUpKeyValue.sqlite`          | `favoriteStickers`, `recentStickers`                                                                                                                                                                                 |

WhatsApp names a person by a JID: `<number>@s.whatsapp.net` or `<LID>@lid`. One person can have both. `users` maps each LID to the phone number when the person shares it.

## Access

The group container needs Full Disk Access. Each store opens on its own. When a store is missing or macOS refuses it, only the streams of that store fail, with `WhatsAppUnavailableError`, which names the store and the grant. When a column that a reader reads is missing, the streams of that store fail with `MissingColumnsError`, and the other stores load. In both cases, the source deletes nothing.

## Limitations

- WhatsApp writes chats and messages only while the app runs. A message gets to the import after WhatsApp ran since the message arrived.
- WhatsApp downloads little media, so most messages load as metadata without their file.
- Each run reads each store fully. When WhatsApp no longer holds a record, the source deletes it.
- WhatsApp removes a contact's status one day after it is posted. Such a status stays in the import. But a status that a contact withdrew before then is deleted. To keep a status, run the source within that day.
- The source does not read the encryption keys, `Labels.sqlite`, `Location.sqlite`, payments or the preferences file.

See [docs/reference.md](../../../../docs/reference.md#whatsapp).
