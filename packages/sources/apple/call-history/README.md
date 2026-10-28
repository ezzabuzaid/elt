# @workspace/source-apple-call-history

An ELT source for the call history of Phone and FaceTime. It reads `~/Library/Application Support/CallHistoryDB/CallHistory.storedata` on this Mac. callhistoryd writes this store and fills it through iCloud from the user's other devices. Thus it holds the phone calls of the iPhone and the FaceTime calls of the Mac. The source does not use the network or the apps, and no app has to be open.

```ts
import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';
import { AppleCallHistorySource } from '@workspace/source-apple-call-history/apple-call-history-source';

// Calls that started on 2026-01-01 or later.
const source = new AppleCallHistorySource(undefined, {
  startAt: '2026-01-01T00:00:00.000Z',
});
const destination = new SQLiteDestination({ path: './calls.sqlite' });

await new Pipeline({
  history: new SQLiteSyncHistory(),
  connections: [
    new Connection({
      name: 'apple-call-history',
      source,
      destination,
      checkpoints: new SQLiteCheckpointStore({ path: './calls-state.sqlite' }),
      steps: [source.calls, source.callParticipants].map(
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

| Stream                | One record per                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `calls`               | call: time, duration, phone or FaceTime, direction, answered, caller ID and blocking      |
| `callParticipants`    | other person on a call: more than one for a group FaceTime call, none for a hidden number |
| `callTimers`          | the call-time totals of the Phone app, in seconds; one record                             |
| `emergencyMediaItems` | photo or video sent to emergency services during a call                                   |
| `saintDavidsCounts`   | count that CallHistory keeps for each call and type code; Apple does not name it          |

The first argument is the path of the store. The second argument is the scope: `startAt` (inclusive) and `endAt` (exclusive) select calls by `startedAt`. `callTimers` always loads in full.

Access: the store needs Full Disk Access for the app that runs the pipeline, such as the terminal. Without it, every stream fails with `CallHistoryUnavailableError`, which names the grant. If the store does not have a column that the source reads, every stream fails with `MissingColumnsError`.

Limitations:

- Every stream is a snapshot stream. Each run reads the full store. A call that is no longer in the store is deleted from the destination. This is also true when macOS removes calls without a deletion by the user: on one Mac, all 521 phone calls before 2025-07-07 went out of the store at the same time.
- A participant is a party to one call, not a contact.
- The values of `emergencyMediaItems` and `saintDavidsCounts` are not verified on a real Mac, because the examined store had no rows in them.

See [docs/reference.md](../../../../docs/reference.md#apple-call-history).
