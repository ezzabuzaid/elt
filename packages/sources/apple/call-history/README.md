# @workspace/source-apple-call-history

An ELT source for the call history of Phone and FaceTime. It reads `~/Library/Application Support/CallHistoryDB/CallHistory.storedata`, the Core Data store of the CallHistory framework, with the SDK `@workspace/sdk-apple-call-history`. callhistoryd writes this store for Phone and FaceTime, and fills it through iCloud from the other devices of the user (`CallHistorySyncHelper`). Thus it holds the phone calls of the iPhone and the FaceTime calls of the Mac. The source does not use the network, the apps or the framework, and no app has to be open.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md), and the glossary of [elt](../../../elt/CONTEXT.md) for the words of all of elt.

```ts
import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';
import { AppleCallHistorySource } from '@workspace/source-apple-call-history/apple-call-history-source';

// ~/Library/Application Support/CallHistoryDB/CallHistory.storedata, calls
// that started on 2026-01-01 or later
const source = new AppleCallHistorySource(undefined, {
  startAt: '2026-01-01T00:00:00.000Z',
});
const destination = new SQLiteDestination({
  path: './outputs/calls.sqlite',
});

await new Pipeline({
  history: new SQLiteSyncHistory(),
  connections: [
    new Connection({
      name: 'apple-call-history',
      source,
      destination,
      checkpoints: new SQLiteCheckpointStore({
        path: './outputs/calls-state.sqlite',
      }),
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

The first argument is the path of the store. The second argument is the scope: see [Date range](#date-range).

A Context Compiler import loads every stream incrementally into its `data.sqlite`. Readers use its `<snake_stream>` views (`calls`, `call_participants`). Every stream of a run reads one snapshot of the store: a read transaction on a read-only connection. The connection is never `immutable`, because callhistoryd keeps a write-ahead log.

## Access

The store needs [Full Disk Access](../messages/README.md#full-disk-access) for the app that runs the pipeline, such as the terminal. On 2026-10-06, a terminal with the grant read the store. A launchd job without the grant got the SQLite error AUTH (23, `authorization denied`). The Accounts store gave CANTOPEN in the same case. The source turns both errors into `CallHistoryUnavailableError`, which names the grant, and every stream fails.

## Streams

| Stream                | Upstream                                      | One record for each                                                                              |
| --------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `calls`               | `ZCALLRECORD`, and its initiator in `ZHANDLE` | call: time, duration, phone or FaceTime, direction, answered, caller ID and blocking             |
| `callParticipants`    | `Z_*REMOTEPARTICIPANTHANDLES`, `ZHANDLE`      | other party on a call: more than one for a group FaceTime call, none for a withheld number       |
| `callTimers`          | `ZCALLDBPROPERTIES`                           | the call-time totals of the Phone app, in seconds; one record                                    |
| `emergencyMediaItems` | `ZEMERGENCYMEDIAITEM`                         | photo or video sent to emergency services during a call                                          |
| `saintDavidsCounts`   | `ZSAINTDAVIDSCOUNTS`                          | count that CallHistory keeps for each call and type code, for a feature that Apple does not name |

The column meanings come from the model of Apple, `CallHistory 46.mom` in `CallHistory.framework`. This is the version that the `com.apple.callhistory.databaseInfo.plist` of the store names.

The `id` of a call is `ZUNIQUE_ID`. It is unique in the store, and it is the same on each device that syncs the call. callhistoryd copies each handle for each call: on 2026-10-06, 3,448 `ZHANDLE` rows held 500 different addresses, and no handle was on two calls. Thus a participant is a party to one call, not a contact, and `calls` carries the initiator. There is no stream for handles ([ADR 0001](./docs/adr/0001-a-call-carries-its-initiator-and-there-is-no-handles-stream.md)). Core Data names the participant join table after entity numbers (`Z_2REMOTEPARTICIPANTHANDLES` on macOS 27), so the SDK finds it by the end of its name.

The source decodes only the codes that Apple names, and it keeps each raw value next to the decoded value:

- `kind`, from `kindCode` (`ZCALLTYPE`): `phone` (1), `faceTimeVideo` (8) and `faceTimeAudio` (16), after `kCHCallTypeTelephony`, `kCHCallTypeFaceTimeVideo` and `kCHCallTypeFaceTimeAudio`.
- `category`, from `categoryCode` (`ZCALL_CATEGORY`): `audio` (1) and `video` (2).

A code that the reader does not know, for example a TTY category or a type that Apple adds later, loads with `kind` or `category` null, and the code stays. All other codes (disconnect cause, filtering, junk confidence, verification, handle type) are numbers that Apple does not document. They load as stored. UUID columns are in uppercase, as `NSUUID` writes them.

`startedAt` is a [`date-time` with `precision` 6](../../../elt/README.md#string-formats) ([ADR 0002](./docs/adr/0002-a-call-start-keeps-its-microseconds.md)). Core Data keeps a date as seconds since 2001-01-01 in a double, which resolves about a tenth of a microsecond today. On 2026-10-06, 2,121 of 2,123 calls held a fraction finer than a millisecond. Thus the SDK writes the time to the microsecond, and not through a JavaScript `Date`.

`emergencyMediaItems` and `saintDavidsCounts` are keyed by their Core Data row numbers. In the model, their call is optional, so a key from the call is not always there.

The source does not read these: the bookkeeping of Core Data (`Z_METADATA`, `Z_MODELCACHE`, `Z_PRIMARYKEY`), and `ZHANDLE` rows that no call refers to. When the model deletes a call, it deletes the participant handles of the call, but it only clears the call from its initiator handle. Thus the 293 such rows on 2026-10-06 are initiators of deleted calls.

## Date range

The scope of the source selects calls by `startedAt`, from `startAt` (inclusive) to `endAt` (exclusive). The source cuts `startedAt` to the millisecond before it compares it with these dates, because a longer fraction sorts before the same time with three digits. `callParticipants`, `emergencyMediaItems` and `saintDavidsCounts` keep the rows of the selected calls, and also each row that names no call, because such a row has no date. `callTimers` covers all calls and always loads in full.

## Changes and deletions

Every stream is a [snapshot stream](../../../elt/README.md#snapshot-streams): a run reads the full store, a record that did not change writes nothing, and a key that is no longer in the store deletes its row. A call that leaves the store is deleted from the destination: when the user removed it from Recents, when Core Data cascaded the deletion, or when callhistoryd dropped it ([ADR 0003](./docs/adr/0003-a-call-that-leaves-the-store-is-deleted.md)).

On this Mac, all phone calls before 2025-07-07, 521 of them, left the store at the same time. The logs of callhistoryd showed no removal in the next 30 days, and CallHistory has no retention rule that tells the cause. elt cannot tell such a loss in the upstream from a deletion: an `expiresBy` horizon needs a retention rule. Thus, if this occurs again, the source deletes those calls from the destination too.

The SDK checks every column that it reads when a snapshot opens. If a macOS layout does not have one of them, every stream fails with `MissingColumnsError`, which names the missing columns, and the destination stays as it was. The SDK looks for the participant join table only when `callParticipants` reads. Thus a store without it fails only that stream, with `CallHistorySchemaError`, which names `Z_*REMOTEPARTICIPANTHANDLES`. The other streams load.

## Watching

A watch polls the `data_version` of the store every second through `CallHistoryStore.version()`. On a commit, for example a new call or a call synced from the iPhone, it wakes every selected stream. On 2026-10-06, a read-only connection saw callhistoryd commit a new call (from 2,121 to 2,122 calls). The next load wrote that call and its participant, and nothing else.

## Live checks

Checked live on 2026-10-06 on macOS 27.0 (26A428):

- The store held 2,121 calls (2,067 phone calls from 2025-07-07, 43 FaceTime video calls and 11 FaceTime audio calls from 2025-02-27), 3,448 handles, 2,108 participant links, one row of call-time totals, and no emergency media or Saint Davids counts. 13 calls named no participant.
- A load through the Context Compiler CLI took 0.4 s. It wrote 2,121 calls, 2,108 participants and 1 call-time row, and each call had a known `kind` and `category`. A second load wrote nothing. `/usr/bin/sqlite3` read every view.
- Two reads with no call between them gave the same hash for each table. Thus no value changes from one read to the next.

Not verified: the values of `emergencyMediaItems` and `saintDavidsCounts`. Both tables are empty here, and the tests use only their declared shapes. Emergency media exists only after media is sent during an emergency call. Apple names neither the Saint Davids feature nor its type codes (`ZSAINT_DAVIDS_1` is 0 and `ZSAINT_DAVIDS_2` is empty on every call here).

## Limitations

- A call that leaves the store is deleted from the destination. This is also true when macOS removes calls and the user did not delete them.
- A participant is a party to one call, not a contact.
- The values of `emergencyMediaItems` and `saintDavidsCounts` are not verified on a real Mac.

## Decisions

- [ADR 0001](./docs/adr/0001-a-call-carries-its-initiator-and-there-is-no-handles-stream.md): a call carries its initiator, and there is no handles stream.
- [ADR 0002](./docs/adr/0002-a-call-start-keeps-its-microseconds.md): a call start keeps its microseconds.
- [ADR 0003](./docs/adr/0003-a-call-that-leaves-the-store-is-deleted.md): a call that leaves the store is deleted.

## Development

Run the commands from the workspace root.

```sh
npx nx run source-apple-call-history:test        # builds, then runs src/*.test.ts
npx nx run source-apple-call-history:typecheck   # formats, lints, then type checks
```
