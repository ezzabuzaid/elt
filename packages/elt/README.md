# @eltjs/elt

Copies the data of apps and services into stores that SQL can read. A source reads an upstream, for example the Mail store of a Mac. A destination keeps each stream as a table, for example in one SQLite file. The pipeline starts the copies, and it keeps derived datasets in step with what they load. A derived dataset is data that the pipeline can always make again from the loaded data, for example the text of each stored file, or a view that counts rows. Kleppmann calls it derived data, and Estuary calls it a derivation.

This README tells how a pipeline copies, resumes, watches, fails and records its passes, and how it keeps derived datasets. The SQLite destination is in [elt-sqlite](../destinations/sqlite/README.md), and the Postgres destination is in [elt-postgresql](../destinations/postgresql/README.md).

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Use it

```sh
npm install @eltjs/elt @eltjs/elt-sqlite
```

A pipeline needs a destination package: `@eltjs/elt-sqlite`, `@eltjs/elt-postgresql` or `@eltjs/elt-sqlserver`. The smallest program loads one row that the host holds into one SQLite file, with one run of the pipeline. It needs only Node, `@eltjs/elt` and `@eltjs/elt-sqlite`.

```ts
import { DatabaseSync } from 'node:sqlite';

import { Connection, Copy, IterableSource, Pipeline } from '@eltjs/elt';
import { SQLiteDestination, SQLiteSyncHistory } from '@eltjs/elt-sqlite';

const source = new IterableSource({
  identity: 'tasks',
  streams: {
    tasks: {
      description: 'Each task that the host holds now.',
      jsonSchema: {
        type: 'object',
        description: 'A task.',
        properties: {
          name: { type: 'string', description: 'Name of the task.' },
          text: { type: 'string', description: 'What the task asks.' },
        },
        required: ['name', 'text'],
      },
      primaryKey: ['name'],
      snapshot: () => [{ name: 'fix-git', text: 'Recover the lost commit.' }],
    },
  },
});
const sqlite = new SQLiteDestination({ path: './tasks.sqlite' });
const pipeline = new Pipeline({
  history: new SQLiteSyncHistory(),
  clock: globalThis,
  connections: [
    new Connection({
      name: 'tasks',
      source,
      destination: sqlite,
      steps: [
        new Copy(source.streams.tasks, sqlite.table('tasks'), {
          syncMode: 'full_refresh',
          destinationSyncMode: 'overwrite_dedup',
        }),
      ],
    }),
  ],
});

await pipeline.run();
const database = new DatabaseSync('./tasks.sqlite', { readOnly: true });
console.log(
  database
    .prepare('SELECT name, text, committed_in FROM raw_tasks')
    .all()
    .map((row) => ({ ...row })),
);
```

Output:

```
[
  {
    name: 'fix-git',
    text: 'Recover the lost commit.',
    committed_in: 1
  }
]
```

[Load rows that the host holds](#load-rows-that-the-host-holds) tells what `IterableSource` does with these rows. [Copy a stream](#copy-a-stream), the next section, copies the streams of a source package.

## Copy a stream

This example copies two streams of Apple Notes into one SQLite file. The pipeline types come from `elt`. The SQLite destination, its checkpoint store and its sync history come from `elt-sqlite`. Each Apple source has its own package, `@eltjs/source-apple-<name>` in `packages/sources/apple`. The later examples use `notes`, `sqlite`, `checkpoints` and `history` from this example.

```ts
import { homedir } from 'node:os';

import { Connection, Copy, Pipeline } from '@eltjs/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@eltjs/elt-sqlite';
import { noteStorePath } from '@eltjs/sdk-apple-notes';
import { AppleNotesSource } from '@eltjs/source-apple-notes/apple-notes-source';

const notes = new AppleNotesSource({ path: noteStorePath(homedir()) });
const sqlite = new SQLiteDestination({ path: './notes.sqlite' });
const checkpoints = new SQLiteCheckpointStore({ path: './checkpoints.sqlite' });
const history = new SQLiteSyncHistory();

const connection = new Connection({
  name: 'apple-notes',
  source: notes,
  destination: sqlite,
  checkpoints,
  steps: [
    new Copy(
      notes.accounts,
      sqlite.table('accounts', (columns) => [
        columns.text('id').primaryKey(),
        columns.text('name').notNull(),
      ]),
    ),
    new Copy(notes.notes, sqlite.table('notes'), {
      id: 'notes-to-sqlite',
      syncMode: 'incremental',
      destinationSyncMode: 'append_dedup',
    }),
  ],
});
const pipeline = new Pipeline({
  history,
  connections: [connection],
  clock: globalThis,
});

const results = await pipeline.run(); // [{ copy, count, deleted }, ...] in declaration order
```

- A `Connection` is the connection of Airbyte: the copies of one source into one destination, with the checkpoints that resume them. Readers of the sync history see its `name`.
- A `Pipeline` is the orchestrator of one or more connections. See [Run and failures](#run-and-failures).
- The pipeline waits and reads the time on its `clock`. A host gives `globalThis`. See [Run a pipeline on a clock](#run-a-pipeline-on-a-clock).
- The copy of `accounts` declares its columns. The copy of `notes` infers its columns from the stream, and it deduplicates on the `id` key of the stream.
- Apple Notes gives its streams as properties: `accounts`, `folders`, `notes`, `inlineAttachments` and `attachments`. `discover()` gives the same frozen streams to code that lists streams.
- A declaration does not read Notes, and `discover()` does not read Notes. Neither opens a store.

## Sync modes

`syncMode` selects how the source extracts. `destinationSyncMode` selects how the destination loads. The SQLite, Postgres and SQL Server destinations have these five pairs:

| Extraction     | Loading           | Result                                                                        |
| -------------- | ----------------- | ----------------------------------------------------------------------------- |
| `full_refresh` | `append`          | Keeps each observation, also an ID that repeats in one pass or across passes. |
| `full_refresh` | `overwrite`       | Replaces the target with this extraction. Repeated IDs stay.                  |
| `full_refresh` | `overwrite_dedup` | Replaces the target with one row for each key, by the dedup policy.           |
| `incremental`  | `append`          | Resumes from the last saved checkpoint, and keeps each emitted observation.   |
| `incremental`  | `append_dedup`    | Resumes from the last saved checkpoint, and keeps one row for each key.       |

- A `Copy` with no third argument is `full_refresh` with `overwrite`.
- An options object must give the two modes.
- The copy refuses `incremental` with `overwrite` or `overwrite_dedup`. It refuses `full_refresh` with `append_dedup`. Use `overwrite_dedup` for that result.
- The modes are immutable metadata of the stream and of the destination:

```ts
notes.notes.supportedSyncModes; // ['full_refresh', 'incremental']
sqlite.supportedDestinationSyncModes;
// ['overwrite', 'append', 'append_dedup', 'overwrite_dedup']
```

The pairs are the [sync modes of Airbyte](https://docs.airbyte.com/platform/using-airbyte/core-concepts/sync-modes). The platform of Airbyte [maps Full Refresh Overwrite + Deduped to `full_refresh` + `overwrite_dedup`](https://github.com/airbytehq/airbyte-platform/blob/main/airbyte-server/src/main/kotlin/io/airbyte/server/apis/publicapi/helpers/AirbyteCatalogHelper.kt). Its [serializer](https://github.com/airbytehq/airbyte-platform/blob/main/airbyte-commons-protocol/src/main/kotlin/io/airbyte/commons/protocol/DefaultProtocolSerializer.kt) maps `overwrite_dedup` to `append_dedup` with generation metadata for a destination that can refresh, and to `overwrite` for other destinations. The [wire protocol enum](https://github.com/airbytehq/airbyte-protocol/blob/main/protocol-models/src/main/resources/airbyte_protocol/v0/airbyte_protocol.yaml) of Airbyte does not have `overwrite_dedup`. elt uses the words of the platform and a protocol in the process. It is not compatible with the wire protocol of Airbyte. The default policy and the tie rule below are choices of elt.

### Dedup policy

`dedupPolicy` selects how `append_dedup` and `overwrite_dedup` resolve a conflict on the key:

| `dedupPolicy`  | Guard on the upsert                         | Use it when                                                                           |
| -------------- | ------------------------------------------- | ------------------------------------------------------------------------------------- |
| `cursor_newer` | `WHERE excluded.<cursor> > target.<cursor>` | The cursor moves forward apart from the key, so a lower cursor is an old replay.      |
| `replace`      | none                                        | The upstream restates facts that it gave before, so the newest extraction is correct. |

- A deduplicating copy with no `dedupPolicy` uses `cursor_newer`. For a stream with `sourceDefinedCursor`, it uses `replace`.
- Under `cursor_newer`, a [deletion](#deletions) has a guard too: `WHERE <deletion cursor> > target.<cursor>`. On a tie, the stored row stays, as it stays for a record.
- The three destinations apply the policy. SQLite applies it as the guard of the upsert. Postgres and SQL Server apply it when they merge each staged commit into their table.
- The copy refuses `cursor_newer` when the cursor is a field of the key. A conflict on that key has an equal cursor, so the guard never applies, and a restated record loads as a no-op that counts but changes no row. The error names the field and tells you to use `replace`.

```ts
// A daily report keyed [account, date] whose upstream restates recent days.
new Copy(source.dailyTotals, destination.table('daily_totals'), {
  id: 'daily-totals',
  syncMode: 'incremental',
  destinationSyncMode: 'append_dedup',
  dedupPolicy: 'replace',
  cursorField: 'date',
});
```

### Deletions

A stream that declares `emitsDeletes` can send `DELETE` messages in an incremental read. The `key` of each `DELETE` holds the fields of the `primaryKey` of the stream, and no other field. Such a stream always declares its key. Its incremental copies must use `append_dedup`, which deduplicates on that key, so the destination can find the row.

The [dedup policy](#dedup-policy) of the copy sets the shape of a `DELETE` and the operation of a key that wins in one commit:

| `dedupPolicy`  | `DELETE`                                  | The operation of a key that wins in one commit                                                       |
| -------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `replace`      | `{ type: 'DELETE', stream, key }`         | The last record or deletion that the source emits.                                                   |
| `cursor_newer` | `{ type: 'DELETE', stream, key, cursor }` | The record or deletion with the greatest cursor. On a tie, the first one that the source emits wins. |

`cursor` is the value of the `cursorField` of the copy at which the upstream deleted the row, of the type of that field. Under `cursor_newer`, a deletion that wins removes the stored row only when its cursor is greater than the cursor of the row. On a tie, the row stays. Thus an old deletion that a replay sends again does not remove a newer row.

```ts
// The upstream deleted note n1 at version 7.
yield { type: 'DELETE', stream: 'notes', key: { id: 'n1' }, cursor: 7 };
```

| Destination                                     | What a `DELETE` that wins does                             |
| ----------------------------------------------- | ---------------------------------------------------------- |
| SQLite, Postgres and SQL Server, `append_dedup` | Deletes the row with that key in the commit of the stream. |

- A `DELETE` of a key that is not there does nothing. Thus a pass can run again safely.
- The copy refuses a deletion when the stream does not declare `emitsDeletes`, when the key is not correct, or when the load does not deduplicate.
- A `cursor_newer` copy refuses a deletion with no `cursor`, or with a `cursor` that is not a valid value of the `cursorField`. The error has the error of the value check as its `cause`. Every other copy refuses a deletion with a `cursor`, because no rule of that copy compares it. Each of these errors is a `TypeError` that names the stream.
- The results count the accepted deletions as `deleted`, apart from `count`. A deletion that loses to a newer row counts too, as a record that `cursor_newer` discards counts in `count`.
- No destination keeps a deletion after its commit. Thus a record that is older than a deletion of an earlier commit loads again, for example in a replay that starts after the commit of the deletion. See [ADR 0032](./docs/adr/0032-a-deletion-older-than-the-stored-row-deletes-nothing.md).

### Resets

A stream that emits deletions can also send `{ type: 'RESET', stream }`. It sends it when the upstream cannot tell what changed since the checkpoint, for example when its change history expired. The stream then starts again in a hidden target:

- What the stream emits after the reset commits into the hidden target. Its checkpoints also go there.
- Readers see the earlier rows until the stream ends with no failure. Then the hidden target takes the place of the target.
- A reload that fails stays hidden. The engine saves with each checkpoint whether a reload is open, so the next run resumes the reload from its last checkpoint.
- The destination drops a hidden target that no checkpoint continues. A new reset starts the reload again.
- For a partitioned stream, a reset applies only to the partition that the source reads. The partition starts again in the hidden target, and the other partitions load into the target as before: readers see the earlier rows of the partition until the stream ends with no failure, and the new rows of the other partitions at each commit. Then the rows of the partition are replaced by difference, as Delta Lake's `replaceWhere` replaces only the rows that its condition selects. The destination records the partitions that a reload reloads, beside the hidden target, so a resumed reload continues them. A deletion whose key does not name its partition applies to the target and the hidden target. See [ADR 0024](./docs/adr/0024-a-reset-of-a-partition-reloads-it-into-a-hidden-target.md).
- A reset that no commit took is undone with the operations after it, when a failure discards them: the checkpoint of the source does not know it.
- A reset drops the operations that the stream staged before it, in its scope.
- `Source.read` gives each reset the scope of its partition.
- A full refresh ignores a reset, because a full refresh starts again in all cases. Thus an appending copy keeps its history.

A stream whose fields changed, or whose stored table does not agree with the stream, reloads in this way only when its copy overwrites. Other copies [evolve](#shape-changes) the target. See [ADR 0007](./docs/adr/0007-a-stream-that-starts-over-reloads-into-a-hidden-target.md).

### Shape changes

The shape of a stream is its fields and their types, and its declarations. The fields and types are its schema without the descriptions. The declarations are its name, primary key, partition key, sync modes, file transfer, source-defined cursor, deletions and expiry. A shape change keeps what the copies loaded. This is the rule of Airbyte: its [schema change management](https://github.com/airbytehq/airbyte/blob/f847ad015360face1837f5a77c64325f104157f0/docs/platform/using-airbyte/schema-change-management.md#L26-L31) never reads a source again by itself. See [ADR 0006](./docs/adr/0006-a-stream-whose-fields-change-keeps-its-rows-and-its-checkpoint.md).

- **Changed fields** (added, removed, a new type, nullable or required) keep the checkpoint and the rows of the copy. Before the copy reads, the destination evolves the stored target to the new shape, in place, as the direct-load destinations of Airbyte [alter a table](https://github.com/airbytehq/airbyte/blob/f847ad015360face1837f5a77c64325f104157f0/airbyte-cdk/bulk/core/load/src/main/kotlin/io/airbyte/cdk/load/component/TableSchemaEvolutionClient.kt#L59-L111):
  - An added column is NULL on the rows that loaded before it.
  - The destination drops a removed column.
  - The destination converts a column with a new type.
  - A stored value that the new type cannot hold fails the copy. The error names the column. The table and the checkpoint stay as they were. Clear the copy to load it again, or change the stream so that the value fits.
  - Rows that the upstream does not hold now stay. Examples are notifications that the upstream forgot, or activity that expired.
- **An overwrite** (`overwrite` or `overwrite_dedup`) replaces all rows in all cases. Thus its stored target reloads into a [hidden target](#resets) of the new shape. The hidden target takes the place of the target when the stream ends. The truncate syncs of Airbyte also [load a new table](https://github.com/airbytehq/airbyte/blob/f847ad015360face1837f5a77c64325f104157f0/airbyte-cdk/bulk/core/load/src/main/kotlin/io/airbyte/cdk/load/table/directload/DirectLoadTableStreamLoader.kt#L222-L246), and they do not alter a table that holds the rows of an earlier sync.
- **A new field gets values from the source**, because the copy resumes from its checkpoint:
  - A snapshot diff emits again each record whose fields changed, because its fingerprint changed.
  - A cursor source whose cursor does not see a new column must record in its state the fields that it read. When a field is added, it reads all rows again, as the [SQL Server source](../sources/microsoft/sql-server/README.md) does. Airbyte leaves this to a [backfill](https://github.com/airbytehq/airbyte-platform/blob/090c5e993543735758a60184546fe87354af3d32/airbyte-commons-worker/src/main/kotlin/io/airbyte/workers/helper/BackfillHelper.kt#L100) setting that clears the state.
- **Changed declarations** stop the copy with `StreamChangeError`, which names them. Airbyte also pauses a connection when its primary key or cursor was [removed](https://github.com/airbytehq/airbyte-platform/blob/090c5e993543735758a60184546fe87354af3d32/airbyte-commons-protocol/src/main/kotlin/io/airbyte/commons/protocol/CatalogDiffHelpers.kt#L320-L350). The host selects one action:
  - `CheckpointStore.reset(id)` keeps the stored rows and loads again from no checkpoint. This is the refresh of Airbyte that keeps records.
  - `pipeline.clear()` drops the rows. This is the Clear of Airbyte.
- **A cursor field that the stream does not describe now** fails the copy before it reads. The copy must select a different cursor. That changes its binding, so the host also resets it.
- **Stored nullability.** A stored table is `NOT NULL` only on `loaded_at`, on `committed_in` and on the explicit primary key columns, because a field that is added later has no value on earlier rows. The Postgres destination of Airbyte also adds columns as nullable, because it does not "know what constitutes a reasonable default value for preexisting records" ([source](https://github.com/airbytehq/airbyte/blob/f847ad015360face1837f5a77c64325f104157f0/airbyte-integrations/connectors/destination-postgres/src/main/kotlin/io/airbyte/integrations/destination/postgres/sql/PostgresDirectLoadSqlGenerator.kt#L608-L615)). The destination still checks each record that it writes for its required fields, and a deduplicating load refuses a NULL key or cursor.

### Target ownership

A target has one writer. Airbyte has the same rule: one stream owns one table, and ["more than one Airbyte connection to sync to the same destination stream… isn't permitted"](https://github.com/airbytehq/airbyte/blob/65c1b23b53ca4929ff18adbc3a3ef92666a3fffe/docs/platform/using-airbyte/configuring-schema.md#L42-L54). An overwrite empties the full target, and a snapshot copy deletes keys that it saw before. Thus the rows of a second writer would be lost. See [ADR 0008](./docs/adr/0008-a-target-has-one-writer.md).

- The writer is the `id` of the copy. For a copy with no `id`, the writer is the source identity and the stream name.
- Each destination records the writer of each target in the reserved table `_elt_writers`. It stores the writer with the target, in the commit of its first load.
- Before a copy extracts or changes anything, the target refuses each other writer with `TargetOwnedError`. The error names the two writers.
- The writer that owns the target can change its own mode or key.
- `location(target)` of a destination is the address of the target in the destination: `"schema"."table"` for Postgres, and the table name for SQLite. It has no path, host or credential. Thus a database that moves to a different folder, or that a host reaches through a different host name, keeps its checkpoints and its stored files. See [ADR 0009](./docs/adr/0009-a-target-is-named-by-its-address-inside-the-destination.md).

To reset or reassign a target, clear it with the copy that owns it, as the Clear of Airbyte does:

- `pipeline.clear()` clears every copy. `pipeline.clear([copy])` sends each copy to its connection. `connection.clear()` clears the copies of one connection.
- A clear empties each target, releases its writer and removes the checkpoint of the copy. The next run loads again from the start.
- A clear empties a table. It does not drop it. Thus views over the table, such as the [warehouse](../../infra/README.md) views, continue to work.
- A clear forgets the rows that it removes, as Delta Lake's `VACUUM` after a `DELETE` does: the history of the table keeps none of them, their stored files go, and each position before the clear expires, because no reading can read it exactly. Thus a host that must keep nothing of a scope, such as data that it no longer may hold, clears the copy and loads it again ([ADR 0023](./docs/adr/0023-a-clear-forgets-the-rows-it-removes.md)).
- A clear refuses a target that a different writer owns.
- A target that a person dropped by hand also releases its writer. Its copy loads it again from no checkpoint, because a resume would load only what changed since the checkpoint.

Several properties or accounts share tables through one [partitioned stream](#partitioned-streams), which is one writer.

## Keys, cursors and schemas

Three different things control identity:

- `Stream.primaryKey` is the identity of the source, as `sourceDefinedCursor` is its cursor (Airbyte calls the key `source_defined_primary_key`). A deduplicating copy of a stream that declares a key uses that key. The key alone does not make a SQL unique constraint, and it does not select deduplication. The key is an identity that the upstream enforces, and no source deduplicates rows ([ADR 0022](./docs/adr/0022-a-stream-s-key-is-an-identity-its-upstream-enforces.md)).
- The `Copy` option `primaryKey: ['id']` or `['tenantId', 'id']` selects the identity only for a stream that declares no key. The constructor of `Copy` refuses `primaryKey` for a stream with a key: `Stream <name> defines its own primary key; omit primaryKey`.
- `.primaryKey()` on a SQLite column is a physical constraint. An append that conflicts with it fails and rolls back that copy. It never becomes an update.

Rules for keys and cursors:

- The two deduplication modes need a key: the key of the stream, or the `primaryKey` of the copy for a stream with no key. Otherwise the copy fails with `Stream <name> declares no primary key; select primaryKey`.
- A load that does not deduplicate refuses `primaryKey` and `dedupPolicy`.
- `cursor_newer` needs `cursorField`. `replace` works with no cursor.
- A stream with `sourceDefinedCursor` has no cursor field. Its copies do not give `cursorField`. Its deduplicating loads use `replace`, and they refuse `cursor_newer`.
- A stream can declare `defaultCursorField: [field]`, as Airbyte's `default_cursor_field`. An incremental copy, or a `cursor_newer` copy, that gives no `cursorField` then compares that field. A stream with `sourceDefinedCursor` cannot declare it.
- An incremental copy of any other stream needs `cursorField`. A full refresh with `append` or `overwrite` refuses `cursorField`.
- The fields must be scalar properties at the top level, with one JSON Schema type that is not null.
- A key can be text, a finite number, a safe integer or a boolean. A cursor can be text or a number.
- A key or a cursor with a [string format](#string-formats) must have its canonical form. A `decimal` field and a base64 field can be keys. They cannot be cursors, because their text does not sort as their values do.
- A missing value or a null value fails. Composite keys are possible. Nested field paths and nullable keys or cursors are not possible.
- An explicit SQL projection must have all the key fields and the cursor, with types that agree.

The greatest cursor wins:

- After validation, the destination ignores a record with a lower cursor.
- With equal cursors, the record that the destination stored first stays, also across runs. Thus a replay gives the same rows. A source that changes the content of a record and does not change its cursor cannot show the two versions apart.
- Text compares by its UTF-8 bytes, as SQLite `BINARY` does. `int64` text compares as 64-bit integers.
- Each value of a `date`, `date-time`, `date-time-local` or `time-local` field has the same width, so its byte order is its time order.
- The destination validates each observation, also a version that loses.

Stream properties are scalars, or arrays of one scalar type or of objects:

- An array field declares `type: 'array'` (or `['array', 'null']`) and an `items` schema. The `items` schema has the type of the element, and its `enum`, range, `minLength` and date `format`.
- `validateRecords` checks each element. It refuses constraints on the array itself.
- An array can also hold objects: `items` is `{ type: 'object', properties, required }`, its properties are scalars, and `required` names each of them, as a record names each property. `validateRecords` checks that each object has exactly those fields, each one valid. A page's language copies, `{ language, url }`, are an example; Airbyte's type system nests objects in arrays the same way.
- Arrays hold lists of values, such as keywords, counts for each day or a page's language copies. A collection whose members are records of their own, with a key and a lifetime, is a different stream of rows.
- Arrays cannot be keys or cursors.

### String formats

A string property can declare its form. Thus a value that a JSON number or a JavaScript `Date` would round keeps its exact value. `validateRecords` accepts one form of each value:

| Schema                                                    | Value                                                                           | Example                        |
| --------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------ |
| `format: 'date-time'`, `precision` 0–9 (3 when not given) | A UTC instant that ends in `Z`, with `precision` fraction digits                | `2025-01-02T03:04:05.1234567Z` |
| `format: 'date-time-local'`, `precision` 0–9 (3)          | A date and a time of a wall clock, with no zone                                 | `9999-12-31T23:59:59.9999999`  |
| `format: 'time-local'`, `precision` 0–9 (3)               | A time of day with no zone                                                      | `23:59:59`                     |
| `format: 'date'`                                          | A calendar date                                                                 | `2024-02-29`                   |
| `format: 'int64'`                                         | A signed 64-bit integer with no leading zeros                                   | `-9223372036854775808`         |
| `format: 'decimal'`, optional `precision` and `scale`     | An exact decimal: `scale` fraction digits when declared, else no trailing zeros | `922337203685477.5807`         |
| `contentEncoding: 'base64'`                               | Bytes as padded RFC 4648 base64                                                 | `AAEC/w==`                     |

- `date-time-local`, `time-local`, `int64` and `decimal` are names from the OpenAPI format registry. The `time` format of JSON Schema requires an offset, so it cannot hold a time of day with no offset.
- `precision` and `scale` have the meaning that they have in SQL.
- elt refuses a declaration that combines these keywords in a different way, or that puts them on a type that is not a string.
- Each destination stores a format in a type that keeps it exact. See the mappings of [SQLite](../destinations/sqlite/README.md#columns) and [Postgres](../destinations/postgresql/README.md#columns).

### Names

A SQL destination gives each column, table and reader view a name that it can hold. It uses the rule of Airbyte, so a field with any name loads:

1. The compatibility decomposition of Unicode (NFKD) separates each mark, and the destination removes the mark (`spécial` becomes `special`).
2. Each sequence of whitespace becomes one `_`.
3. Each other character that is not in `[A-Za-z0-9_]` becomes `_` (`名前` becomes `__`). The case stays.
4. A name that starts with `_elt_`, in any case, loses its first `_` (`_elt_seq` becomes `elt_seq`), because elt names its own tables and columns with `_elt_`.
5. An empty name becomes `_`.
6. A name that starts with a digit gets a `_` in front (`1st` becomes `_1st`).

- Columns get their names in the order of the fields. When an earlier column has the name, the field gets `_1`, then `_2` and so on, after it (`a b` becomes `a_b`, and a later `a_b` becomes `a_b_1`).
- The names that the destination writes come first. In the three destinations they are `loaded_at`, `committed_in`, `_elt_row_hash` and `replaced_in`. SQLite also has `_rowid_`, Postgres has the system column names `xmin`, `xmax`, `cmin`, `cmax`, `ctid` and `tableoid`, and SQL Server has `_elt_row` and `_elt_key_hash` (`packages/destinations/sqlserver/src/sql-server-identifiers.ts`). Thus a field `loaded_at` becomes `loaded_at_1`.
- Postgres compares names with their case. SQLite compares names without ASCII case, so `Foo` and `foo` become `Foo` and `foo_1`.
- A table or view does not see the names of other tables. When the rule changes its name, the name gets `_` and the first 8 hex digits of the SHA-256 of the requested name (`dbo.a b` becomes `dbo_a_b_<hash>`). Thus two requested names never share a table.
- Postgres keeps only 63 bytes of a name. A longer name keeps its first 54 bytes, then `_` and the first 8 hex digits of the SHA-256 of the field or the requested name. SQLite has no length limit.
- When the rule changes a column name, the column description ends with `Source field: "<field>".` The catalog shows that description, so a reader can find the field.
- The names come only from the fields of the stream, so each run gives the same names. A change of fields evolves the stored table ([shape changes](#shape-changes)).
- Schema names and the names of published views do not change, because the SQL of the caller uses them. A destination refuses such a name when it cannot hold it.

## Incremental copies and checkpoints

- An incremental copy needs a stable `id` and a [checkpoint store](#checkpoint-stores).
- The IDs must be different across all connections of a pipeline. Each ID has its own progress.
- A connection copies each stream one time. To load one stream into two targets, use two connections with two IDs (see [read context](#read-context)).

The read:

- `Source.read(catalog, states, signal)` gives each incremental stream its saved state, or `null` on its first run. `extract` gets it as `state`.
- `extract` emits records `{ stream, data }`, [deletions](#deletions) `{ type: 'DELETE', stream, key }` (with `cursor` for a `cursor_newer` copy), [resets](#resets) `{ type: 'RESET', stream }` and checkpoints `{ type: 'STATE', stream, state }`.
- Their text must be well-formed Unicode. A string or a field name with a lone surrogate fails its stream, because SQLite would store U+FFFD and Postgres refuses it.
- The state belongs to the source. It must go into JSON and come back with no change. Destinations do not read it.

Keyed entries ([ADR 0035](./docs/adr/0035-a-checkpoint-keeps-keyed-entries-beside-its-state.md)):

- A state that holds one record for each key, such as each URL that a crawl knows, can keep those records as entries beside `state`. A save then writes only what changed, not every key again.
- A `STATE` can carry `entries`: for each space, `put`, pairs of a key and a value, and `remove`, keys. Each `put` and `remove` is an iterable, such as an array or a `Map`. A space names one consumer of the state, such as `crawl` or `diff`, so the keys of two spaces do not meet.
- `{ type: 'STATE', stream, state, entries: { crawl: { put: [[url, known]], remove: [gone] } } }` changes these keys and keeps every other entry. A `STATE` with no `entries` changes no entry.
- Keys and spaces are well-formed strings with no U+0000, and each value must go into JSON and come back with no change, as `state` must. One `STATE` puts or removes a key, not both; the last put of a key wins. Any other shape fails the stream before the records before the `STATE` commit, and the store saves nothing of that `STATE`.
- `extract` gets the saved entries as its last argument, `entries: SavedEntries`. `await entries.space('crawl')` reads that space from the store when the extract asks, as a `ReadonlyMap`. The map is empty on the first run, after a [reset](#checkpoint-stores) and when the target is new or a reload starts over.
- The entries belong to the stream, and to the partition for a [partitioned stream](#partitioned-streams): two partitions that put one key keep two entries, and each partition's `extract` reads only its own.
- A partition that the stream no longer lists loses its entries in the save that drops its state. A `RESET` clears the entries of its partition, or of the whole stream, at the next `STATE`, before that `STATE`'s own changes; until then the extract still reads the saved entries, as its `state` stays the saved one. A reload that resumes keeps them.
- The store saves the entries with the state in one transaction, after the writer committed the records before the `STATE`.

Each checkpoint is a commit point, as in Airbyte:

- The writer commits all that came before the checkpoint, then it acknowledges the checkpoint. The store saves it before the load continues.
- A run that fails later keeps each checkpoint that it acknowledged, and the next run resumes from the last one.
- With no acknowledgement there is no progress, also when the source changes its input state.
- When `extract` throws, `Source.read` does not throw. It reports a `FAILED` stream status for that partition or stream, as the error trace of Airbyte does. The stage of the stream discards what it staged after its last checkpoint, and it commits nothing more until the next checkpoint.
- A source tells of a failed read with a throw. It never yields nothing in place of a throw.
- A full refresh has no checkpoints. It commits one time, at the end, and a failure keeps the earlier target.

The binding:

- The store binds each ID to its copy: the source identity, the `location` of the target and the selected configuration.
- The store also binds each ID to the shape of its stream: its schema, key and sync modes, without the descriptions.
- The columns of a target are not part of the binding. Thus a changed field keeps the checkpoint, also when the target declares its columns, and the destination evolves its target.
- A changed declaration stops the copy with `StreamChangeError` until the host resets or clears it ([shape changes](#shape-changes)).
- A changed description only updates the comments of the target.
- A changed copy fails before it extracts. Use a new ID, or reset the progress:

```ts
await checkpoints.reset('notes-to-sqlite'); // The next read starts from null; the destination data stays.
await pipeline.run();
```

- `reset` keeps the loaded rows, as the refresh of Airbyte that keeps records. A reset of append progress can duplicate data. A reset of deduplicated progress reconciles the records that the source gives again.
- To drop the rows also, [clear the copy](#target-ownership).
- Do not share a state file between machines that are not related. The parent folder of the file must exist.

Delivery is **at least once**:

- The store saves a checkpoint after its rows commit, in a different store.
- When the rows commit and the save fails, the copy reports that failure with the committed counts. The next run starts again from the last saved checkpoint.
- Append keeps the observations that come again. Deduplication reconciles them.
- elt has no full refresh that resumes.

### Checkpoint stores

The state belongs to the orchestration, not to the destination, as in Airbyte. Thus any store works with any destination, also with a destination that cannot hold state. The replication saves each checkpoint only after the rows of its stream before it committed.

- `CheckpointStore.run(bindings, work)` does that protocol for all incremental copies of a pass together. It checks the binding of each copy, clones the input state, and moves forward only on a commit. `reset` and `clear` are also part of it.
- A store gives a session that holds the lock of each copy for the full pass. A `save` of the session is durable when it resolves, and writes the checkpoint and the changes of its keyed entries in one transaction. A save whose read started from no checkpoint replaces every entry, and a save can clear a scope, the start of the spaces of a partition or of the whole stream; `reset`, `clear` and the end of a reload that started over with no `STATE` remove them.
- With each checkpoint, the store saves whether a reload is open ([resets](#resets)).
- `CheckpointStore.failureType(error)` gives the [failure type](#failure-types) of each error that the store raised. Each store must implement it.

| Store                              | Package                                                            |
| ---------------------------------- | ------------------------------------------------------------------ |
| `SQLiteCheckpointStore({ path })`  | [elt-sqlite](../destinations/sqlite/README.md#checkpoints)         |
| `PostgresCheckpointStore({ url })` | [elt-postgresql](../destinations/postgresql/README.md#checkpoints) |

## Snapshot streams

A source with no change feed can still load incrementally with `diffSnapshot(configuration, records, state, { policy, signal })`. This is a [snapshot differential](https://github.com/JanuaryLabs/zukhruf/tree/main/packages/snapshot-differential#readme) (Labio and Garcia-Molina, VLDB 1996). The recipe [Write a source for an upstream with no change feed](./docs/recipes/write-a-source-for-an-upstream-with-no-change-feed.md) gives a full source that uses it.

`SnapshotDifferential` of `@zukhruf/snapshot-differential` compares one scan with the earlier snapshot, and gives the inserts, the updates, the deletions and the new state. It knows nothing of a copy. `diffSnapshot` and `diffGroupedSnapshot` of elt use it, and add what a copy needs (`src/core/snapshot.ts`):

- **The check of the copy.** The stream must declare `sourceDefinedCursor`. The key is the `primaryKey` of the stream, and each key value is checked as a deduplicating copy reads it. A stream that declares `emitsDeletes` must give a policy. A stream that does not declare it gives no policy, and each vanished key leaves the snapshot with no `DELETE`. A declaration that breaks these rules fails with a `TypeError` that names the stream, and a key value that is not valid fails with a `TypeError` that names the field.
- **The full refresh.** A copy that is not incremental does not compare. The diff emits each record of the scan and saves no state.
- **The messages of a source.** Each change becomes a record of the stream, a `DELETE` with the fields of the `primaryKey`, or the `STATE` of the stream.
- **The stop.** The diff gives the event loop a turn and checks `signal`, so a cancelled run stops (see **Stop** below).

- The stream declares `sourceDefinedCursor`. It declares `emitsDeletes` when its upstream deletes records. A [forgetting upstream](#forgetting-upstreams) does not declare it.
- The source gives one complete scan, the earlier state, a deletion policy, and the signal of the run that its `extract` gets:

```ts
import { ClosedWorld } from '@zukhruf/snapshot-differential';

protected override async *extract(configuration, state, partition, context, signal) {
  // The scan lists every record, so a key it does not list was deleted.
  yield* diffSnapshot(configuration, this.scan(configuration.stream), state, {
    policy: new ClosedWorld(),
    signal,
  });
}
```

- The state is `{ snapshot: { <JSON of the key values>: <SHA-256 of the record> } }`.
- Each run emits new or changed records, a `DELETE` for each vanished key that the policy judges deleted, and then the new snapshot as the only `STATE`.
- Records that did not change make no writes.
- The first run (state `null`) loads all records and deletes nothing.

The policy is a `DeletionPolicy`. It is a Strategy that gives each vanished key a verdict:

- `deleted`: the closed-world assumption. The diff emits a `DELETE`.
- `unknown`: the open-world assumption. The key stays in the snapshot, and the next run judges it again.
- `expired`: a time to live. The key leaves the snapshot with no `DELETE`.

`ClosedWorld` judges each vanished key deleted. `Retention(horizon)` is for [expiring upstreams](#expiring-upstreams). `Coverage(covers)` is for [partly held upstreams](#partly-held-upstreams). A source with a different rule writes its own subclass. A stream that declares `emitsDeletes` must give a policy. A stream that does not declare it gives no policy.

- **Replay:** when the checkpoint save fails after the data committed, the next run compares with the older snapshot. It applies the same upserts and deletions again and gets the same rows.
- **Failures:** an empty scan deletes all rows. The source must throw on a failed read. It must never yield an empty collection in place of the read. The diff refuses a key that comes two times in one scan, so a source that reads windows that overlap must remove the duplicates first.
- **Cost:** the source still reads all records on each run. Only the writes of the destination become fewer. The state holds one key and a fingerprint of 43 characters for each row, so it grows with the stream.
- **Stop:** a scan that finds no change yields no message until its state. A scan that never waits for I/O would make all other tasks of the process wait until it ends, also the stop of the host. Thus the diff gives the event loop a turn (`setImmediate`) after each 1,000 items, and checks `signal` at each record or group. A count of items, not a time, sets the turns, so the diff reads no clock. An item diffs in microseconds, so a turn comes in a few milliseconds (5499b8cc). A cancelled run stops in moments. It never ends as a complete scan, which could delete the keys that it did not read. `signal` is required, so no source can leave it out.
- **Reset:** a reset of the checkpoint makes the next run load all records again, but it forgets which rows exist. Rows that the upstream deleted in that time stay. Reset and clear the target together, or run a full refresh with `overwrite`.
- **Full refresh:** the source calls `diffSnapshot` in the same way in the two sync modes. In a full refresh, the diff checks the declaration of the stream as an incremental copy does. Then it emits each record of the scan, one at a time, as the scan yields it, and it saves no state. The copy replaces its target, so it compares nothing. The CDK of Airbyte does the same: `Stream.read` selects its checkpoint reader by the sync mode, so the mode stays a concern of the framework and never gets to the code of the stream.

### Grouped snapshots

Some records come from inputs that the source can fingerprint and not read, such as files whose stat identifies their content. For them, `diffGroupedSnapshot(configuration, groups, snapshot, { policy, signal })` does not read the unchanged inputs:

```ts
protected override async *extract(configuration, state, partition, context, signal, entries) {
  yield* diffGroupedSnapshot(
    configuration,
    this.files(configuration.stream),
    await resumeGroupedSnapshot(configuration, entries),
    { policy: new ClosedWorld(), signal },
  );
}
```

- Each group is `{ key, fingerprint, records() }`: one input, a fingerprint of it, and a function that reads its records.
- In an incremental copy, a group whose fingerprint is equal to the saved fingerprint of its key keeps its saved rows. The diff does not call its `records()`. The diff reads and compares each other group, and each group whose fingerprint is `null`, record by record.
- A source that knows that a group did not change can give a kept group, `{ key, kept: true }`, with no fingerprint. The group keeps its saved rows. A kept group that the snapshot does not have fails the diff. A full refresh reads each group, so it refuses a kept group.
- A source that could not read an input, such as a page that answered 503, can give a failed group, `{ key, failed: true }`. The group keeps its saved rows, so a failure deletes nothing, and a row that another group gives moved out of it. A failed group that the snapshot does not have keeps nothing. A full refresh gives no rows for a failed group: the failure fails the read, so the target keeps its last complete scan.
- **The snapshot is in the keyed entries** ([ADR 0036](./docs/adr/0036-a-grouped-snapshot-is-kept-in-three-spaces-of-keyed-entries.md)). It has three keyed collections, each in its own space of the stream's [keyed entries](#incremental-copies-and-checkpoints), and of the partition's for a partitioned stream: `diff` has `<group key>: { fingerprint, snapshot }`, with `snapshot` as above; `diff:unknown` has `<key>: { saved, holder? }`, the keys that the policy judged unknown and the keys that wait for the last part of a scan in parts, with the group that held them; `diff:listed` has `<group key>: true`, the groups that the earlier parts of an open scan listed. `resumeGroupedSnapshot(configuration, entries)` reads the three spaces and checks each entry. The snapshot is empty on the first run.
- **A save writes what changed.** The `STATE` of the diff has `state: null`, and its `entries` put and remove only the entries that changed: each group that the diff read and that changed, a group that a record moved out of, the unknown keys that changed, and the groups that a part lists for the first time in its scan. The part that ends a scan removes every listed group. Thus a part that reads one page writes the entry of that page and its listed entry, not the whole snapshot.
- **A scan in several calls.** The `STATE` also has `snapshot`, the new snapshot. A source that diffs one scan in several calls of one `extract`, as the web source diffs each page of a crawl, gives it to the next call, and yields `{ type: 'STATE', stream, state, entries }` with a `state` of its own. A source that diffs once yields the messages as they are.
- **Deletions:** the policy judges each key that no group gave in this run, kept or read. With `ClosedWorld`, a vanished input deletes its rows, and a changed input deletes the rows that it does not give now. The groups must still come from a complete list: the source lists each input on each run, and it skips only the read.
- **Fingerprints:** a fingerprint must change each time that the records of the group can change, also when the parse code of the source changes. A version constant in the fingerprint does this. A fingerprint that misses a change keeps old rows, and no error tells of it.
- **Moves:** a row that moves to a different group is compared with its earlier fingerprint, wherever it was. Thus it loads only when it changed. The diff refuses a key that comes two times in one run, also from a kept group, and a group key that comes two times in one run.
- **Airbyte:** the [file-based cursor](https://github.com/airbytehq/airbyte-python-cdk/blob/d5536bc78c261a5f7d89595cb811c8bad676e251/airbyte_cdk/sources/file_based/stream/cursor/default_file_based_cursor.py#L82-L111) also skips files that did not change. It uses only the modification time, keeps at most 10,000 files before it uses a time window, and never emits deletions. Groups keep each fingerprint, compare it for equality and not for recency, and delete from the complete list.

### Expiring upstreams

Some upstreams keep records only for a time, and then drop them with no deletion. For example, macOS keeps activity for 28 days, and Safari keeps history for the age that the user set. A snapshot diff would delete those rows also. A stream that declares `expiresBy` keeps them. `expiresBy` is the name of a millisecond `date-time` property that is not null. Its source gives each diff a retention from the horizon from which the upstream keeps records: `diffSnapshot(configuration, records, state, { policy: new Retention(horizon), signal })`, and the same for `diffGroupedSnapshot`. A diff of such a stream with no policy fails.

- **Expiry:** each snapshot entry also saves the `expiresBy` value of the record (`[fingerprint, expiresBy]`). The policy gets it as `{ key, expiresBy }`. A vanished key with a value before the horizon expired: it leaves the snapshot with no `DELETE`, and its row stays. A vanished key at or after the horizon is deleted. Thus a deletion that the upstream makes in its retention still gets to the destination.
- **The horizon:** the source sets it on each read from the retention rule of the upstream. It never sets it from the oldest record that it finds, because a "clear all" leaves no old record and would make each deletion an expiry. An earlier horizon misses deletions of the oldest records. A later horizon deletes rows that the upstream only expired. Thus sources set it with a margin inside the retention.
- **Returns:** a key that comes back after it expired, such as an event that a different device synced late, loads as new.
- **Bounded state:** expired keys leave the state, so the state grows with what the upstream keeps, not with all that the copy loaded.
- **Rows outlive the upstream:** a clear of the copy, or a full refresh with overwrite, loses each expired row. No run can read it again. A reset keeps them, and a change of the fields of the stream also keeps them ([shape changes](#shape-changes)). Nothing marks a loaded row as expired.
- **Precedent:** the [`delete-insert` of dlt](https://github.com/dlt-hub/dlt/blob/1.30.0/dlt/destinations/sql_jobs.py#L200-L234) and [`scd2` with a `merge_key`](https://github.com/dlt-hub/dlt/blob/1.30.0/dlt/destinations/sql_jobs.py#L969-L990) also remove only rows in what a load loaded again. Airbyte deletes only on change data capture markers, and its [refreshes guide](https://github.com/airbytehq/airbyte/blob/0eef98ff7f266392e6d1e1077e80d66971f2a378/docs/platform/operator-guides/refreshes.md#L36-L96) names a source that "does not retain all of its records" as the case where a truncate loses data. In elt, the source limits deletions by time, because it knows the retention of the upstream.

### Partly held upstreams

Some upstreams hold only a part of their records, and they tell which part. For example, the Slack app keeps the parts of each conversation that it loaded, and it records their ranges. A message that vanished in a range that the cache still holds was deleted. A message out of all ranges only left the cache. The source gives the diff a `Coverage` with the vanished records that the read vouches for:

```ts
import { Coverage } from '@zukhruf/snapshot-differential';

protected override async *extract(configuration, state, partition, scan, signal) {
  // A vanished message is deleted only where the app still holds the history.
  yield* diffSnapshot(configuration, this.scan(configuration.stream), state, {
    policy: new Coverage(({ key }) => scan.holds(key.workspaceId, key.channelId, key.ts)),
    signal,
  });
}
```

- **What the predicate gets:** each key that the snapshot has and that the read does not list, as the fields of the primary key. For an [expiring](#expiring-upstreams) stream it also gets the saved `expiresBy`. It returns whether the read covers that record, which means that the record was deleted.
- **Keys with no cover:** a key that the read does not cover is unknown. It stays in the snapshot with no `DELETE`, and its row stays. A later read that covers it and does not list it deletes it, for example when the app loads a conversation again without a message that a person deleted in that time. A later read that lists it with no change writes nothing.
- **State:** the snapshot keeps each unknown key. Thus it grows with the rows that the upstream does not hold now and that no read can judge.
- **Who decides:** only the source knows what its upstream holds now. Thus the rule is an argument of each read, never a declaration of the stream: what a cache holds changes with each read.
- **Rows outlive the upstream**, as for expired rows: a clear of the copy, or a full refresh with overwrite, loses each row with no cover.
- **Precedent:** Airbyte deletes only on change data capture markers, and its Slack source never deletes. The Slack connector of Fivetran reads all history again to find deletes. A read that covers all records does the same.

### Re-read windows

Some reads ask for a window, and the next read asks for a part of it again. For example, Search Console reads each day from the last settled day, because Google can still restate those days. Without help, the snapshot would hold each record that the first read loaded, sixteen months of them, and a later read that starts after a day would see the rows of that day as vanished. The source tells the diff which records the next read reads again:

```ts
// The next read starts at the last settled day.
yield *
  diffSnapshot(configuration, rows, state, {
    policy: new ClosedWorld(),
    rereads: (record) => String(record.date) >= nextStart,
    signal,
  });
```

- **What stays:** only the records that `rereads` accepts stay in the saved snapshot. This is the lookback window. Thus the state holds no more than what the next read compares. A record that is not in the snapshot cannot vanish from that read, so its row stays and is never deleted.
- **What is deleted:** a kept record that the next read does not give now. An example is a query that Google stopped to report for a day that the source reads again, or each row of a day that comes back empty.
- **Who decides:** the source sets where its next read starts, from its own checkpoint. Thus `rereads` and that start come from the same value. When the source keeps fewer records than the next read covers, rows that the read stopped to give stay. When it keeps more, the diff deletes rows that the read did not ask for.
- **Precedent:** the Search Console source of Airbyte reads only final data, and it says that its ["syncs do not delete rows"](https://github.com/airbytehq/airbyte/blob/4bc984c55bafae1fdf1f09d9dcc62fbea0a98241/docs/integrations/sources/google-search-console.md#L246-L247). Fivetran syncs a rollback window of seven days again and does not find deletes. The [`delete-insert` of dlt](https://github.com/dlt-hub/dlt/blob/5084786a456038fab4b4e05f50492a718430d0a6/docs/website/docs/general-usage/merge-loading.md#L22-L29) with a merge key replaces at the destination each day that a load brings. A day that comes back empty brings no merge key, so it keeps its rows.

### Scans in parts

Some upstreams cannot list all records in one run. For example, an API pages slowly and answers a client that reads too much with "Please wait a few minutes", as Instagram does. A profile of 3,479 posts is 106 pages, and a run reads 10. The source lists each page as one part of a scan that later runs continue. The diff deletes only when the scan ends:

```ts
for await (const page of profile.pages(after)) {
  yield *
    diffSnapshot(configuration, page.posts, state.diff, {
      policy: new ClosedWorld(),
      continues: page.hasNext, // more parts follow: delete nothing yet
      signal,
    });
}
```

- **What a reader sees:** a new or changed record loads with the part that lists it. A record that no part of the scan listed is deleted when the part that ends the scan commits. Until then, each row stays.
- **State:** while a scan is open, the snapshot also keeps the keys that its parts listed (`listed`). A part is a commit: a run that fails keeps the parts before it, and the next run continues after them.
- **Lag:** a record that is deleted after a part listed it is deleted when the next scan ends. Two parts can list one key. One part cannot list it two times.
- **Precedent:** the resumable full refresh of Airbyte keeps its page token only between the attempts of one job, and its truncate refresh keeps each row hidden until the sync ends. Neither lets one scan continue through syncs that succeed. See [ADR 0002 of snapshot-differential](https://github.com/JanuaryLabs/zukhruf/blob/main/packages/snapshot-differential/docs/adr/0002-a-scan-can-be-listed-in-parts.md).

### Forgetting upstreams

Some upstreams drop records for reasons that they do not record, so nothing shows a deletion apart from the other reasons. For example, Notification Center deletes a notification when its app withdraws it, when the user clears it, when a newer one replaces it, or when it expires, and all of them are the same `DELETE`. A stream over such an upstream does not declare `emitsDeletes`. The diff then never emits a `DELETE`, and each row that it loaded stays.

```ts
// Notification Center forgets notifications: no emitsDeletes, so a vanished
// one keeps its row. Its source diffs each scan as any snapshot stream does.
const notifications = new Stream({
  ...declaration,
  sourceDefinedCursor: true,
});
```

- **What changes:** only deletions. New and changed records load as in each snapshot stream, and a record that did not change writes nothing.
- **Bounded state:** a vanished key leaves the state, so the state holds what the upstream keeps now. A key that comes back loads as new.
- **No policy:** such a stream takes no policy. `expiresBy` needs `emitsDeletes`: an expiring upstream deletes in its retention, a partly held upstream deletes in what it holds, and a forgetting upstream never deletes.
- **Rows outlive the upstream**, as for expired rows: a clear of the copy, or a full refresh with overwrite, loses them. A reset, or a change of the fields of the stream, keeps them. Nothing marks a loaded row as gone from the upstream.
- **Airbyte:** it deletes destination rows only "if your source supports emitting deleting records (e.g. an CDC database source)" ([incremental append + deduped](https://docs.airbyte.com/platform/using-airbyte/core-concepts/sync-modes/incremental-append-deduped)). An incremental stream with no deletions keeps each row that it loaded. In elt this is a declaration on the stream, not a property of the source.

## Load rows that the host holds

A host that holds rows in its own memory or store loads them with an `IterableSource`. It writes no `Source` subclass. It gives a schema, a key and the rows of each stream. dlt does the same with `pipeline.run(data)`, and LangChain with `index(docs)`. See [ADR 0033](./docs/adr/0033-a-host-loads-the-rows-it-holds-through-an-iterable-source.md).

This example loads the tasks that a host holds into one SQLite file. It runs three passes: the first loads two tasks, the second gives one changed task and stops giving the other, and the third gives the same rows again.

```ts
import { DatabaseSync } from 'node:sqlite';

import { Connection, Copy, IterableSource, Pipeline } from '@eltjs/elt';
import { SQLiteDestination, SQLiteSyncHistory } from '@eltjs/elt-sqlite';

// The rows that the host holds. A real host reads them from its own store.
let tasks = [
  { name: 'fix-git', text: 'Recover the lost commit.', difficulty: 'easy' },
  {
    name: 'build-pmars',
    text: 'Build pMARS from source.',
    difficulty: 'medium',
  },
];

const source = new IterableSource({
  identity: 'tasks',
  streams: {
    tasks: {
      description: 'Each task that the host holds now.',
      jsonSchema: {
        type: 'object',
        description: 'A task.',
        properties: {
          name: { type: 'string', description: 'Name of the task.' },
          text: { type: 'string', description: 'What the task asks.' },
          difficulty: {
            type: 'string',
            enum: ['easy', 'medium', 'hard'],
            description: 'How hard the task is.',
          },
        },
        required: ['name', 'text', 'difficulty'],
      },
      primaryKey: ['name'],
      deletions: 'closed-world',
      snapshot: () => tasks,
    },
  },
});
const sqlite = new SQLiteDestination({ path: './tasks.sqlite' });
const pipeline = new Pipeline({
  history: new SQLiteSyncHistory(),
  clock: globalThis,
  connections: [
    new Connection({
      name: 'tasks',
      source,
      destination: sqlite,
      steps: [
        new Copy(source.streams.tasks, sqlite.table('tasks'), {
          syncMode: 'full_refresh',
          destinationSyncMode: 'overwrite_dedup',
        }),
      ],
    }),
  ],
});

const rows = () =>
  new DatabaseSync('./tasks.sqlite', { readOnly: true })
    .prepare(
      'SELECT name, difficulty, committed_in FROM raw_tasks ORDER BY name',
    )
    .all()
    .map((row) => ({ ...row }));

await pipeline.run();
console.log('first', rows());

// The host changes one task and stops holding the other.
tasks = [
  { name: 'fix-git', text: 'Recover the lost commit.', difficulty: 'hard' },
];
await pipeline.run();
console.log('second', rows());

// The same rows again: no row is written.
await pipeline.run();
console.log('third', rows());
```

Output:

```
first [
  { name: 'build-pmars', difficulty: 'medium', committed_in: 1 },
  { name: 'fix-git', difficulty: 'easy', committed_in: 1 }
]
second [ { name: 'fix-git', difficulty: 'hard', committed_in: 2 } ]
third [ { name: 'fix-git', difficulty: 'hard', committed_in: 2 } ]
```

- **One stream for each key of `streams`.** `source.streams.tasks` is the frozen `Stream` for a `Copy`. It supports `full_refresh` and `incremental`, and it defines its own cursor. The host writes none of these flags.
- **The rows of a pass.** Each pass calls `snapshot({ signal })` one time and pulls the rows as the destination asks for them. The rows can be an `Iterable` or an `AsyncIterable`. elt keeps no buffer: a pass that fails reads the rows again from the host. `signal` is the signal of the run, so rows that wait on the host stop with the run.
- **Deletions.** With `deletions: 'closed-world'`, the host gives every row that it holds, and a row that it stops giving is deleted. The stream then emits deletions. Without it, a row that the host stops giving stays loaded, as in a [forgetting upstream](#forgetting-upstreams). The source has no cleanup option: the sync modes of the copy and `deletions` are the cleanup.
- **A key that comes two times** in one pass fails the read in both sync modes: `Snapshot tasks returned name a twice in one scan`. Two rows for one key show that the key of the host is wrong ([ADR 0022](./docs/adr/0022-a-stream-s-key-is-an-identity-its-upstream-enforces.md)). A key can have more than one field.
- **Rows that did not change write nothing.** A full refresh with `overwrite_dedup` replaces rows by difference in each destination, so the third pass keeps `committed_in` 2. An incremental copy with `append_dedup` compares each row with the [snapshot](#snapshot-streams) in its checkpoint, and keeps that snapshot in the checkpoint store of the connection.
- **Which mode.** `full_refresh` with `overwrite_dedup` needs no checkpoint store and no copy `id`. Use `incremental` with `append_dedup` when the target is so large that a comparison of the whole target at each pass costs more than a snapshot of about 55 bytes for each row. For 5,500 rows, an unchanged pass took 156-270 ms in a full refresh and 105-199 ms in an incremental copy.
- **`rowVersion`** names a column whose value changes each time the host changes the row, such as a version counter. An incremental copy then compares that value in place of the hash of the row (dlt `row_version_column_name`). **Hazard:** a row whose content changed but whose version did not change keeps its old content. The column must be in `jsonSchema`; the constructor refuses another name with a `TypeError`. A full refresh reads every row and does not use it.
- **Watch.** `source.changed(stream)` tells a watch that the host's rows of the stream changed; the next check, at most one second later, starts a pass. A host whose rows are in a store that it can watch also gives `changeSignal: { gauge: (clock) => gauge, interval, timeout }`. The watch gets a new gauge for each watch, and `changed()` works beside it with the same interval.
- **Coverage** of each pass is `{ description, selection: {} }`, with the `description` of the stream. `currentAsOf` is null, unless the stream gives `currentAsOf: () => Promise<Date | null>`. `configErrors` lists the error classes of the host that the user must fix; the failure type of other errors is `system`.

### Changes since a version

A host that keeps a version for each change, such as an `updated_at` or a sequence number, gives only the changes after the version that elt saved. Its stream has `changes` in place of `snapshot`, and names its `cursorField`. A change is a row, or a tombstone `{ deleted: key, version }` for a row that the host deleted. dlt does the same with `incremental("updated_at")` and `merge` with a `hard_delete` column.

This example runs two passes over the change log of a host. The second pass gives one changed task and a tombstone for the other.

```ts
import { DatabaseSync } from 'node:sqlite';

import { Connection, Copy, IterableSource, Pipeline } from '@eltjs/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@eltjs/elt-sqlite';

// The change log of the host: each change has the version that the host gave
// it. A real host reads it from its own store.
let log: (
  | { name: string; text: string; version: number }
  | { deleted: { name: string }; version: number }
)[] = [
  { name: 'fix-git', text: 'Recover the lost commit.', version: 1 },
  { name: 'build-pmars', text: 'Build pMARS from source.', version: 2 },
];

const source = new IterableSource({
  identity: 'tasks',
  streams: {
    tasks: {
      description: 'The tasks that changed after a version.',
      jsonSchema: {
        type: 'object',
        description: 'A task.',
        properties: {
          name: { type: 'string', description: 'Name of the task.' },
          text: { type: 'string', description: 'What the task asks.' },
          version: { type: 'integer', description: 'Version of the task.' },
        },
        required: ['name', 'text', 'version'],
      },
      primaryKey: ['name'],
      cursorField: 'version',
      ordered: true,
      changes: ({ since }) => {
        console.log('since', since);
        return log.filter(({ version }) => since === null || version > since);
      },
    },
  },
});
const sqlite = new SQLiteDestination({ path: './tasks.sqlite' });
const pipeline = new Pipeline({
  history: new SQLiteSyncHistory(),
  clock: globalThis,
  connections: [
    new Connection({
      name: 'tasks',
      source,
      destination: sqlite,
      checkpoints: new SQLiteCheckpointStore({ path: './state.sqlite' }),
      steps: [
        new Copy(source.streams.tasks, sqlite.table('tasks'), {
          id: 'tasks',
          syncMode: 'incremental',
          destinationSyncMode: 'append_dedup',
        }),
      ],
    }),
  ],
});

const rows = () =>
  new DatabaseSync('./tasks.sqlite', { readOnly: true })
    .prepare('SELECT name, version FROM raw_tasks ORDER BY name')
    .all()
    .map((row) => ({ ...row }));

await pipeline.run();
console.log('first', rows());

// The host changes one task and deletes the other.
log = [
  ...log,
  { name: 'fix-git', text: 'Recover the two lost commits.', version: 3 },
  { deleted: { name: 'build-pmars' }, version: 4 },
];
await pipeline.run();
console.log('second', rows());
```

Output:

```
since null
first [
  { name: 'build-pmars', version: 2 },
  { name: 'fix-git', version: 1 }
]
since 2
second [ { name: 'fix-git', version: 3 } ]
```

- **The host names `cursorField` once.** `source.streams.tasks` supports `full_refresh` and `incremental`, emits deletions, and declares `defaultCursorField: ['version']`, so a copy that selects no `cursorField` compares `version`. Each copy deduplicates with `cursor_newer` on that field. A copy with another `cursorField` or `dedupPolicy` fails the run before a read, with a `TypeError`: `Stream tasks gives changes by version; a copy of it deduplicates with dedupPolicy cursor_newer on cursorField version`.
- **`since`.** Each pass calls `changes({ since, signal })` one time. `since` is the greatest version that the copy saved, or `null` before the first save and in a full refresh. A pass whose rows committed but whose checkpoint did not save gives the same `since` again, so the host gives the same changes again. The replay changes no row.
- **Old changes lose.** A row with a version below the version of the stored row changes nothing, and a tombstone with a version below it deletes nothing ([Deletions](#deletions), [ADR 0032](./docs/adr/0032-a-deletion-older-than-the-stored-row-deletes-nothing.md)). On a tie, the stored row stays.
- **When a pass saves.** Without `ordered`, a pass saves one checkpoint at its end, with the greatest version that it gave. With `ordered: true`, the host promises versions in order, and the pass saves each time the version rises, so a pass that fails halfway keeps what it loaded. Changes that share a version save together: a pass that stops between two changes at version 5 gives `since` 4 again. A version below the version before it fails the stream: `Stream tasks gives ordered changes, but version 7 came after version 9`.
- **A tombstone holds `deleted`**, so the `jsonSchema` of a changes stream cannot declare a property `deleted`; the constructor refuses it with a `TypeError`.
- **Versions** are text or numbers, in the order that the destinations compare them: numbers by value, `int64` text as integers, other text by byte order. `since` and the `version` of a tombstone have the type of the cursor field: a number for `version` above. A nullable or boolean field cannot be the `cursorField`.

## Partitioned streams

One source can read a stream as several partitions, for example one for each Search Console property or each account. The stream declares `partitionKey`, which is a subset of its `primaryKey`. The source lists the partitions from its configuration, and `extract` gets each partition:

```ts
protected override partitions(stream) {
  return this.siteUrls.map(siteUrl => ({ siteUrl }));
}

protected override async *extract(configuration, state, partition) {
  // state is the checkpoint of this partition, or null the first time.
}
```

`Source.read` calls `extract` one time for each partition, in the listed order, and keeps the state of each partition apart. The checkpoint is `{ partitions: [{ partition, state }] }`, and the library owns it. Each time that a partition saves a checkpoint, the library emits the full envelope: the new state of that partition and the latest state of each other listed partition. Thus each partition commits when it is complete.

- **New partition:** it gets `null` and starts from the normal start of the source, for example a backfill of the full history. The other partitions resume.
- **Removed partition:** it leaves the next checkpoint. Its rows stay. When a later read lists it again, it starts from `null`.
- **Identity:** the list of partitions is not part of the source identity or of the checkpoint binding. Thus a partition that you add or remove never invalidates the checkpoints of the others.
- **Rows:** each record and each `DELETE` key must hold the values of its partition. A row that names a different partition, or no partition, fails that partition. The `partitionKey` fields are members of the `primaryKey` of the stream, so the key of a deduplicating copy always has them.
- **Failures:** as in Airbyte, a partition that fails does not stop the others in an incremental read. The rows of that partition after its last checkpoint are discarded, and it keeps its saved state. Thus the next run tries it again from there. The other partitions commit and move forward. The copy then reports the failed partitions, and the run fails and names each one. elt never skips a failed partition without a report.
- **Full refresh:** the partitions are read in the same way, with no state. An overwrite replaces the full target with all listed partitions. A partition that fails in a full refresh stops the read of the stream, because a full refresh commits nothing after a failure.

`Source.read` asks for the partitions at the start of each read, and a watch asks at its start. Thus a source whose host changes them, for example the inputs of a web stream, gives the list as it is then. The `partitionKey` fields must be different scalar members of the primary key that are not null. The list must have no repeated partition.

- **No partition:** the stream reads nothing. Its checkpoint stays as it is. An Airbyte partition router with no values also gives no slices.

## Read context

A pass is one read of one connection: one `Source.read(catalog, states, signal)` over each stream that the connection selected, as `read(config, catalog, state)` of Airbyte. `Pipeline.run()` makes one pass for each connection. The source opens one context for the full read, so related streams tell of the same moment of the upstream. Separate reads would let a stream that joins refer to a row that its parent stream never saw.

```ts
class ChatSource extends Source<ChatDatabase> {
  protected override open(streams, signal, states) {
    return ChatDatabase.open(this.path); // AsyncDisposable, disposed when the read ends
  }

  protected override async *extract(configuration, state, partition, database) {
    // database is the read's context
  }
}
```

- **Contract:** each source implements `open(streams, signal, states)`. It gets the streams that the read covers, the signal of the run and the saved states of the read, which `read` receives. A context whose streams depend on the checkpoint of another stream reads it there, as the web pages source reads the delivery number of each routes stream. An `open` that waits for its upstream gives the signal on, so a cancelled run stops it, as Calendar and Reminders stop their EventKit helper.
  - An upstream with a read transaction holds it (Messages; Notes; Contacts, one time for each account store).
  - An upstream without one reads each selected stream first, in one window with no change, and gives the streams from that snapshot (Calendar and Reminders; see [EventKit consistency](../sdks/apple/eventkit/README.md#consistent-reads)).
  - A source whose streams do not have to agree returns an empty `AsyncDisposableStack` (Search Console).
- **Stream status:** each stream reads as `STARTED`, then its messages, then `ENDED`. A partition or stream that failed adds `FAILED` with its error. Only `Source.read` makes a `StreamStatus`. A `StreamStatus` that `extract` yields fails its stream with a `TypeError`. So does a message that names a stream other than the stream that the source extracts. Thus a stream can never write into the target of a different stream.
- **Interleaving:** `protected concurrency` (1 when not set) sets how many streams read at the same time. Their messages interleave. The read asks a stream for its next message only after the consumer took its last message, so the file of a record stays valid until the consumer moves on. A source that sets a higher value reads its context from several extracts together. The partitions of one stream always read one after the other. The streams of a read are one task group: when one throws outside its extract, the signal that the others read with aborts, so a stream that waits for another ends with the read ([ADR 0018](./docs/adr/0018-the-streams-of-a-read-are-one-task-group.md)).
- **Lifetime:** the context opens when the read starts and closes when it ends, also when it fails. A watch reads one time in each pass and holds nothing between passes, because a long read can block the maintenance of the upstream.
- **Failures:** a context that cannot open (a refused permission, a missing store) fails each copy of that pass. `PipelineError.cause` is the error. The passes of other connections continue.
- **One copy for each stream:** a connection copies each stream one time (`Connection <name> copies each stream once`), as the configured catalog of Airbyte lists each stream one time. To load one stream into two targets, use two connections. A connection that copies a stream two times does not read: the run rejects with this `TypeError`, the sync history records a failed attempt with one coverage row for each stream (through its first copy), and `passChannels.failure` publishes the `PassFailed`.

## Stored files and document parsing

A stream that supports file transfer, such as `attachments` of Notes, gives a file with each record. A copy declares in its columns what it takes from the file: the parsed text, or a stored file.

```ts
import { Connection, Copy, LocalFiles, Pipeline } from '@eltjs/elt';
import { SQLiteSyncHistory } from '@eltjs/elt-sqlite';
import { MacOSDocumentParser } from '@eltjs/source-apple-macos/macos-document-parser';

const files = new LocalFiles({ directory: './outputs/attachments' });
const attachmentCopy = new Copy(
  notes.attachments,
  sqlite.table('attachments', (c) => [
    c.text('id'),
    c.text('noteId'),
    c
      .text('content')
      .from(notes.attachments.file)
      .parse(new MacOSDocumentParser()),
    c.text('attachmentRef').from(notes.attachments.file.store(files)),
  ]),
  {
    syncMode: 'full_refresh',
    destinationSyncMode: 'overwrite',
  },
);

await new Pipeline({
  history: new SQLiteSyncHistory(),
  clock: globalThis,
  connections: [
    new Connection({
      name: 'apple-notes-attachments',
      source: notes,
      destination: sqlite,
      steps: [attachmentCopy],
    }),
  ],
}).run();
```

This copy stores the selected metadata of the source, the parsed `content`, and an `attachmentRef` as `TEXT`. The ID of the attachment and the ID of its note stay available for joins.

### Declarations

- `notes.attachments.file` is an immutable reference to the file of the source, not a path. The other streams of Notes refuse file access.
- `.from(file)` selects the file of the source. `.parse(parser)` asks for its text.
- `.store(files)` on the file reference selects a file storage, apart from the connection and the destination. Two fields can use different storages, and copies can share one storage and still own their files apart.
- A stored file and parsed text must be separate fields. `.parse()` on a stored file field is refused.
- A file field is a `TEXT` column of parsed text, `.from(file).parse(parser)`, or of stored file references, `.from(file.store(files))`. A file field with neither fails before the copy extracts. `.notNull()` and `.primaryKey()` apply to these fields.
- A plain `c.blob('bytes')` reads the existing `bytes` field of a record into an inline value.
- Types that do not agree, the file reference of a different stream, and fields with the name of a field of the source metadata or of `loaded_at` fail before the copy extracts.
- A bare table still infers the metadata schema of the source. To keep all metadata beside the file columns, spread `SQLiteColumns.fromSchema(notes.attachments.jsonSchema)` into the columns.
- All declarations are immutable and do no I/O. A storage that you make and a field that you declare do no I/O either. The copy never writes the source schema again to describe the fields of the destination.
- One copy can take several named forms of one file. The copy reads each record one time. Fields with the same parser instance share one parse, and fields of stored files share one read. Separate copies keep separate extraction and checkpoint progress.
- To keep no original file, leave out the stored reference. To export no file, leave out all file columns.

```ts
// Text only, under a destination field name you choose.
new Copy(
  notes.attachments,
  sqlite.table('attachment_text', (c) => [
    c.text('id'),
    c
      .text('search_text')
      .from(notes.attachments.file)
      .parse(new MacOSDocumentParser()),
  ]),
);
```

### How a source gives files

- `Source.read()` is the shared template method. A source implements `extract(configuration, state, partition, context, signal, entries)`, and yields metadata, an optional file path, and state.
- `Source.read()` resolves `configuration.fileReads` into parsed text or a `FileContent` before it yields the record. A `FileContent` is valid until the consumer takes the next record.
- A path must stay readable until the consumer moves past its record. It can be a staged copy that the source removes after, or the original file when a copy would cost too much. Notes and Messages give their original attachment files.
- The replication refuses a record that still holds a source file path (`Destinations cannot receive source file paths`).
- A source names a staged copy with `fileExtension` from `elt`: the extension of the file when it is 1 to 16 letters or digits, else none. The original file name stays in the source metadata.
- A source that must download a file, such as one that reads a cloud API, downloads it only when a field accepts its name: `configuration.fileReads.some((read) => read.accepts(name))`. A field with a parser accepts what its parser accepts. A field of stored files accepts every file, unless its reference is narrowed: `stream.file.accepting(parser).store(files)` stores only the files that `parser` accepts, so a [computed dataset](#attachment-text) that parses the stored copies with the same parser gets no file it cannot read. A record whose file no field accepts yields `file: null`, and a field that does not accept a yielded file loads null. Airbyte's file-based sources likewise choose files by name, with [globs](https://github.com/airbytehq/airbyte-python-cdk/blob/f77450f74def59598cda8e1e9a4e975031710c18/airbyte_cdk/sources/file_based/file_based_stream_reader.py), before they read one.

### Local files

`LocalFiles({ directory })` stores the original bytes, and returns their path relative to its folder: `.elt-files/<scope hash>/<content hash><extension>`. This path is the ref of the stored file.

- An import that moves with its files keeps each ref, because the identity of `LocalFiles` names no folder. See [ADR 0015](./docs/adr/0015-a-stored-file-s-ref-is-relative-to-its-folder.md).
- SQLite and Postgres get only that text value. They do not make paths or write files.
- `LocalFiles` resolves its folder when you make it.
- It streams each file in chunks of at most 4 MiB into a temporary file (owner-only, `0600`), syncs it, and then publishes it atomically.
- The scope is the target of the destination, the writer of the copy and the field. The content hash (SHA-256) makes a repeated save stable, and it never overwrites a stored file.
- The extension comes from `fileExtension`.
- An empty file is a real file of zero bytes. A source file that is not available gives a null ref.
- The replication flushes each declared scope one time before its rows commit. It does not flush the folder for each file. A flush of a scope with no files does nothing. New parent folders are synced when they are made.

### Files in the database

Each destination gives a file storage in its own database: `sqlite.files()`, `postgres.files()` and `sqlServer.files()`. A copy and a rule use it as they use `LocalFiles`:

```ts
const attachments = postgres.table('attachments', (c) => [
  c.text('id'),
  c.text('attachmentRef').from(notes.attachments.file.store(postgres.files())),
]);
const attachmentCopy = new Copy(notes.attachments, attachments);
const attachmentText = new ComputedDataset({
  into: postgres,
  name: 'attachment_text',
  description: 'The text of each stored attachment.',
  from: [attachments],
  compute: new DocumentText({
    parser: () => new MacOSDocumentParser(),
    files: postgres.files(),
    column: 'attachmentRef',
  }),
});
```

- Use it when the host of the writer gets a fresh disk, such as a container that a deploy or a restart makes again: a folder of `LocalFiles` is then empty, and the next reconcile fails the copy. The files of a database file storage stay with the rows that name them.
- The table keeps each file in chunks of at most 4 MiB: the SHA-256 of the scope, the name of the file, the place of the chunk from 0, and its bytes. An empty file is one empty chunk. The name is the SHA-256 of the bytes and the short source extension, as `LocalFiles` names its files. The ref is `<scope hash>/<name>`. See each destination for its table.
- The identity names the kind of database, not a server, a database or a folder. Thus a warehouse that moves keeps its refs and its checkpoints.
- Each call of the storage uses a connection of its own, not the connection of the load. A save writes its chunks under a pending name, and then renames them to the name of the content in one statement, only when the scope has no file of that name. Thus a save again gives the same ref and never overwrites a file. Each statement commits on its own, so a save is durable when it resolves, before its rows commit, and `flush` has nothing to do. The pending chunks of a failed save are not referenced, so the next reconcile removes them.
- `open(ref)` writes a temporary copy, named as the file is stored, into a folder of its own (owner-only) in the temporary folder of the system. Its dispose removes the folder. `head(ref, length)` reads only the chunks that hold the first `length` bytes, and of those only the bytes it needs.
- A ref that the table does not hold throws a `StoredFileMissingError` that names the table and the ref, and tells you to reload the copy that stored the file.
- The storage calls its errors `config` or `system` as its destination does: an error of a permission is `config`.

### Files and rows

- The transfer saves the files before it applies the records, and commits the rows before it removes files that are not used now.
- It asks each destination for the refs that its committed rows keep. Thus an update that the cursor refuses cannot delete the file of the row that won.
- Append keeps the files of each observation that it keeps. A replace, a delete, an empty overwrite and `Copy.clear()` remove a file only when no row of this scope refers to it.
- A source failure discards the pending rows and reconciles with the rows that stay.
- Files and rows do not share a transaction. A failed save stops its rows and its checkpoint.
- A cleanup failure after a commit keeps the committed data, but the checkpoint does not move. A replay is safe.
- A failed write or a stopped run can leave files that no row refers to. The next run reconciles them, from the committed refs, before it extracts.
- A missing referenced file, a ref that is not a file, and a managed folder that is not valid fail with an error.
- Keep the stored files until you clear the copy and load it again.

### Write a file storage

For a different storage, extend the exported `FileStorage`:

| Member                       | Gives                                                                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `identity`                   | A stable identity. It is part of the checkpoint binding of the copy.                                                         |
| `reference`                  | A sentence that tells readers what a ref is. Postgres writes it as the comment of the ref column.                            |
| `save(scope, content)`       | Saves a `FileContent`, and returns a complete, immutable ref. A save again of the same content returns the same ref.         |
| `flush(scope)`               | Makes the completed saves durable before their rows commit. It is safe to repeat, also for a scope with no saves.            |
| `retain(scope, references)`  | Removes only the objects of this scope that no committed ref names.                                                          |
| `open(ref, signal?)`         | A `{ path }` that stays readable until it is disposed. A ref that the storage does not hold throws `StoredFileMissingError`. |
| `head(ref, length, signal?)` | The first `length` bytes of the stored file, or all of them when the file is shorter, with no copy of the file.              |
| `failureType(error)`         | The [failure type](#failure-types) of each error that `save`, `flush` or `retain` raised.                                    |

- The transfer reads refs as text that it does not interpret. Thus an S3 storage can return its own form of ref, with no change to the destinations.
- Two kinds exist now: `LocalFiles`, and the [database file storage](#files-in-the-database) of each destination. The reconcile of each scans the kept refs and the files of the scope at each commit: the folder of the scope, or the rows of its chunk 0. Neither keeps a separate index of objects.
- For a storage in a database, extend `DatabaseFiles<Connection>`. It is a template class: it owns the content hash, the chunks, the pending name, the reconcile, the temporary copy and its dispose, and the missing ref. A subclass gives `identity`, `failureType`, `connect()` (a connection of its own, with the table made when absent) and the SQL of `write`, `rename`, `remove`, `names` and `read`. `SQLiteFiles`, `PostgresFiles` and `SqlServerFiles` are the three subclasses.
- A rule reads a stored file only through its storage: `DocumentText` disposes each opened file after its parse. `LocalFiles` gives its own path, and its dispose does nothing. A database file storage gives a temporary copy, and its dispose removes it. See [ADR 0030](./docs/adr/0030-a-rule-reads-a-stored-file-through-its-storage.md).
- A ref that `LocalFiles` does not hold throws a `StoredFileMissingError` that names the folder and the ref, and tells you to reload the copy that stored the file.
- `LocalFiles` calls an error of the file system `config` when a person must change the folder: `EACCES` and `EPERM` (this process may not write it) and `EROFS` (a read-only file system). Each other error is `system`.

### Write a document parser

Extend `DocumentParser` with `parse(path, signal?): Promise<string | null>`.

- Return `null` when the file has no text that the parser can show. Throw only when the read failed.
- Give it a stable identity that includes its version and the configuration that matters. Keep the parser and its configuration immutable, and do not change the file.
- `identityFor({ name, head })` gives the identity of the format that reads one stored file, or `null` when the parser does not handle it. A composite parser uses it, so that a new audio model does not invalidate the text of other formats. `name` is the file name of the ref, with its extension. `head(length)` reads the first bytes of the file through its storage, and only when the parser calls it. The default gives the identity of the parser and reads no bytes, so `OfficeDocumentParser` reads nothing at a refresh. The type of the argument is `DocumentFile`.
- `accepts(fileName)` tells a source, before it downloads a file, whether the parser can read a file of that name. It returns `true` by default: the parser then decides from the content, as `MacOSDocumentParser` does for a file with no extension.
- A parser does not depend on a source or a destination.
- The identity of the parser is part of the checkpoint binding of the copy. A new identity needs a new copy ID or a reset of the checkpoint.
- Keys and cursors stay metadata fields. A checkpoint is acknowledged only after the rows before it commit.
- `MacOSDocumentParser` is the parser of the Apple sources. See [source-apple-macos](../sources/apple/macos/README.md#parsing).

Airbyte has the same two concepts on the source side: its [file parser Strategy](https://github.com/airbytehq/airbyte-python-cdk/blob/f77450f74def59598cda8e1e9a4e975031710c18/airbyte_cdk/sources/file_based/file_types/file_type_parser.py) reads files, and its [file transfer](https://docs.airbyte.com/platform/using-airbyte/sync-files-and-records) moves the original content with its metadata. The parser of elt gives plain text, not the Markdown of Airbyte. elt does not claim the full format and OCR support of Airbyte, or wire compatibility.

### Attachment text

A copy can store files with no parse: an `attachmentRef` column and no `content` column. The import then never waits for a parse, and a file that the parser cannot read fails no copy. The text of the stored files is derived data, not a source, because its input is what the pipeline wrote. Declare it as a [computed dataset](../destinations/sqlite/README.md#declare-a-computed-dataset) with the `DocumentText` rule, and give the rule the file storage that keeps the files. The pipeline reads the files through that storage as the copies commit them. [Context Compiler](https://github.com/ezzabuzaid/context-compiler/blob/main/docs/connectors-and-hosts.md) keeps an `attachment_text` view in this way, which SQL joins on `attachmentRef = ref`:

```sql
SELECT a.id, t.content
FROM attachments a JOIN attachment_text t ON t.ref = a.attachmentRef
WHERE t.content LIKE '%invoice%';
```

- A stored file is addressed by its content in its field. Thus one file that is attached in three chats is one stored file. The same bytes that two streams store are two stored files.
- A parser whose identity changes reads again the files that it handles. A format that the parser stops to handle keeps the text that it read.
- Query the loaded `content` with SQL, or index it with SQLite FTS5 in the application. A parse makes no search index. elt has no query API and no general transform step.

## Watch for changes

Use the same pipeline for continuous copies:

```ts
const controller = new AbortController();

for await (const event of pipeline.watch({ signal: controller.signal })) {
  if (event.kind === 'refresh') {
    // A derived dataset started to fail. The watch goes on.
    console.warn(`Derived dataset ${event.dataset} failed`, event.error);
    continue;
  }
  const { connection, outcomes } = event;
  // This pass's copies have already extracted, loaded, and saved their checkpoints.
}

// Call controller.abort() from your app's stop/shutdown handler.
```

- The watch checks the declarations of each connection first. Then each connection reads the change signals of its own source, and it runs a pass over the copies whose streams changed.
- The copies keep their modes. Incremental copies of Notes and Calendar stay incremental, and full refresh copies stay full refresh. A change notice does not give records, and it does not make a full refresh copy incremental.
- `run()` stays one execution. The hosts of [Context Compiler](https://github.com/ezzabuzaid/context-compiler/blob/main/docs/connectors-and-hosts.md) call the two.

The source owns the detection of changes. For example, the [EventKit SDK](../sdks/apple/eventkit/README.md#watch) watches Calendar and Reminders, and the [Notes source](../sources/apple/notes/README.md#watch) watches the store of Notes.

Passes and checks:

- The passes of one connection run one after the other. The passes of different connections run side by side, and each waits only for the consumer. Thus a slow source never holds back a different source.
- Changes that come while a pass extracts, or while the caller handles a result, go into the set of pending streams of that connection. They cause one next pass, not a queue with no limit.
- The first check of a connection reads each gauge at once. Thus each selected stream is changed or failed. The first pass starts only when each interval had its first check, or its first read failed or timed out. Thus the first pass loads each stream that changed, as one pass.
- Each interval and timeout of the change signals has its own checks. At a check, a stream is changed when one of its gauges changed, else failed when one of them failed, else unchanged.
- At each check, a stream is current as of that check when it has no pending change, no pass reads it, and its last copy loaded completely. When its source tells that its upstream was last current at an earlier time, the stream is current as of that earlier time.
- The pipeline gives each check to `checked()` of its sync history. `checked()` records the first check of a connection at once, and after that at most one time each minute. Only then does it ask the source. Thus `current_as_of` keeps moving while nothing changes, and it stops where the upstream stopped.
- A stream whose change failed to load stays current only as of the time before that change. Thus a failed refresh shows as a `current_as_of` that gets older. A Debezium heartbeat and a Beam watermark on an idle partition show in the same way that a source is caught up.
- The watch yields a `WatchEvent`: a `Pass` or a `DatasetFailure`. A loop narrows on `kind`.
- Each pass yields a `Pass`, `{ kind: 'pass', connection, outcomes }`, after its load and its checkpoints are durable. Each outcome has the committed `count` and `deleted` and its `failures`, which is empty when the copy loaded completely. The counts are accepted observations, also deduplication no-ops and keys that were not there.
- A pass that did not load completely does not end the watch, as Airbyte keeps the schedule of a connection after a failed sync. The caller sees its failures, and the failed partitions keep their checkpoints. See [ADR 0010](./docs/adr/0010-a-watch-keeps-watching-after-an-incomplete-pass.md).

Retries:

- A stream whose copy failed for a `system` reason, by any one of its failures, loads again with no change. The platform of Airbyte also tries a failed sync attempt again, with these delays for an attempt that made no progress: 10 seconds after the failure, then 30, 90 and 270 seconds after each next failure in a row.
- After the fifth failure in a row, the stream waits for the next change of its source, and that change starts the count again.
- A pass that loads the stream completely stops the count. Records that a failed pass committed do not change the wait.
- A stream whose copy failed only for `config` reasons does not load again until its source reports a change, because only the user can fix it.
- A change that the source reports loads its stream at once, also while the stream waits for a retry. A change to a different stream does not bring a retry earlier.
- Retries stop when the watch stops. While a stream waits, its `current_as_of` does not move.
- A retry is due when `performance.now()` of the pipeline's clock reaches its time, a monotonic clock that a wall clock set back or forward does not move. A timer that ends before that time makes the watch wait again, without using the processor.
- See [ADR 0011](./docs/adr/0011-a-watch-loads-a-stream-again-after-a-system-failure.md).

When a change signal fails:

- A failed change signal fails only its streams. The other streams of the connection continue to load. A failed stream is not current as of the check.
- The sync history records the failure one time, when the change signal starts to fail, as a failed pass of its streams with the failure type of the error.
- After a `system` failure, such as a connection that its upstream dropped, the next check reads the gauge again, as Prometheus scrapes a failed target again at its next interval. The first check that reads the gauge loads its streams again, also when the value did not change. Thus the sync history has a pass after the failed one, and a stream that failed for one check does not show as failed until its next change.
- After a `config` failure, the watch reads that gauge no more, and its streams stay failed, because only the user can fix it. A new watch reads the gauge again.
- An upkeep that fails is recorded in the same way, as a failed pass of the streams of the connection. After a `system` failure it runs again at its next interval. After a `config` failure it runs no more in this watch.
- Change signals that break the contract stop their connection: a change signal names a stream that the connection did not select, a selected stream is in no change signal, the change signals of one stream have two intervals or two timeouts, or an interval or a timeout is not a positive number of milliseconds. A `changeSignals()` that throws also stops its connection. The sync history records it as a failed attempt. The other connections continue.
- See [ADR 0020](./docs/adr/0020-a-source-gives-its-change-signals-and-a-failed-signal-fails-only-its-streams.md) and [ADR 0021](./docs/adr/0021-a-source-keeps-its-upstream-producing-through-an-upkeep.md).

When a watch stops:

- When each connection stopped, or the signal aborts, the watch throws the errors of the stopped connections together as a `WatchError`. A `WatchError` is an `AggregateError`. Its message joins entries `Connection <name>: <message>`, and each error has the error that stopped the connection as its `cause`.
- A `WatchError` holds only failures that the sync history recorded. An error that the sync history throws itself, such as a write that fails or an error of the host code in a history wrapper, is recorded nowhere. It stops each connection at once, and the watch rejects with that error itself.
- When the history cannot record a failure, the watch rejects with a `SuppressedError`. Its `error` is the error of the history, and its `suppressed` is the failure.
- A dataset failure does not stop the watch. The watch yields it as a `DatasetFailure`. See [When a derived dataset fails](#when-a-derived-dataset-fails).
- The pipeline does not reconcile on a schedule, and it does not disable a connection.

Stop:

- An abort stops the checks and the upkeeps of each connection. It stops each pass that runs, as `run({ signal })` does: the history records the pass as `cancelled`, and the watch yields it with that outcome. No other pass starts.
- Each connection then disposes its gauges and waits for its upkeeps to end, for example for the end of a helper process, for at most one second. A gauge or an upkeep that ignores the signal stays behind, so one source cannot hang the stop of its host.
- A `break` out of the loop also stops the checks and the pass of each connection. The history records that pass as `cancelled`.
- A new watch reads the change signals of each source again and makes a first pass again, from the saved checkpoints.
- Change notices are not durable. The limits of the snapshot or the cursor of the source still apply.

A custom source:

- It declares a `catalog`.
- It implements `changeSignals(streams, clock)`: the change signals of the selected streams. Each one is a gauge of `@zukhruf/async`, the streams that it tells about, and the interval and timeout of its checks ([ADR 0020](./docs/adr/0020-a-source-gives-its-change-signals-and-a-failed-signal-fails-only-its-streams.md)). It is a declaration: it does no I/O, and each gauge opens what it reads in its first read. The pipeline reads the gauges, and a gauge that fails fails only its streams.
- It implements `coverage(stream): ExtractionCoverage`, what a pass over the stream asks the upstream for (see [coverage](#coverage)).
- A source that must keep doing an action while a watch runs, such as keeping an app running when only that app syncs its store, declares `upkeep(clock)` ([ADR 0021](./docs/adr/0021-a-source-keeps-its-upstream-producing-through-an-upkeep.md)).
- The base `Source` owns `discover()` and `validate()`. Before it extracts, it refuses each stream that is not the same object as the stream of that name in its catalog. The schema of a stream shapes the destination, so it refuses a different stream with the same name.
- Add rules of the source, such as a cursor field that it requires, in `validateExtraction()`.
- A gauge that holds a native resource, such as a connection or a helper process, is `Disposable` or `AsyncDisposable`. The pipeline disposes it when the watch stops. A read that throws fails that gauge for that check.
- `Stream` stays immutable metadata. The load goes through `Source.read`, `Copy` and the writers of the destination.

The tests cover real file system events in temporary storage, the watch subscription of the EventKit helper and its stop on abort, and that the destination and the checkpoints show the data before the watch yields the results. The native file system test needs an environment that permits file system notices. The command sandbox of this host reports `EMFILE` also for one watcher of a temporary folder, and the same probe works outside the sandbox.

## Run a pipeline on a clock

A pipeline waits and reads the time: a watch waits between its checks, before it loads a failed stream again, and between the runs of an upkeep, and a gauge can wait or read the time. All of these use the `clock` that you give to the pipeline. The pipeline gives its clock to each source and to the destination on each call, so one pipeline runs on one clock. See [ADR 0019](./docs/adr/0019-a-pipeline-waits-and-reads-the-time-on-the-clock-that-its-caller-gives.md).

- A host gives `globalThis`.
- A test gives `createClock()` of `@sinonjs/fake-timers` and moves it with `await clock.tickAsync(ms)`. A test that does not wait gives `globalThis`.
- A source that reads the time reads it from the clock of the call: `changeSignals(streams, clock)` and `upkeep(clock)` for a watch, and `open(streams, signal, states, clock)` for a read. A source that reads the time in `extract` keeps the clock in its context.
- A destination reads the time of a load from `load({ clock })`.
- A sync history records the time that the pipeline gives with each event. See [Sync history](#sync-history).

## Sources and their hosts

- Each Apple source is a package in `packages/sources/apple/<name>` (`source-apple-<name>`) with its readers and tests.
- The readers that several sources share are in `source-apple-macos`. EventKit access and its Swift helper are in `sdk-apple-eventkit` (`packages/sdks/apple/eventkit`).
- The Context Compiler plugin and its CLI register a connector for each source. Each connector loads into a SQLite import of its own. See [connectors and hosts](https://github.com/ezzabuzaid/context-compiler/blob/main/docs/connectors-and-hosts.md) for their imports, presets, published views and retries.
- The Google app is the host of the Google sources. See [apps/google](../../apps/google/README.md).
- Each host records each pass and its declared coverage beside the data that it loads. The Google app uses `PostgresSyncHistory` in the warehouse. The hosts of Context Compiler use `SQLiteSyncHistory` in the `data.sqlite` of each import.
- A host that knows that no other process runs a pass of its connections, such as the leader of the flight of a connection, makes `new SQLiteSyncHistory({ soleWriter: true })`. See [elt-sqlite](../destinations/sqlite/README.md#sync-history).
- `Pipeline` puts the failed streams and partitions in its errors.

## Run and failures

`Pipeline({ connections, history })` is the orchestrator.

Before a read, `run()` and `watch()` validate each declaration of each connection:

- The connection names are different, and the copy IDs are different across the pipeline.
- The copies of each connection: unknown streams, a stream that two copies read, pairs of modes that are not supported, schema declarations that are not valid, and missing keys, cursors, IDs or checkpoint stores.
- A connection that is not valid stops the full pipeline before it extracts or makes storage. Its [sync history](#sync-history) records a failed attempt for that connection.
- The validation uses metadata. The run checks storage permissions, existing constraints, target ownership and record values when it executes.

`run()` then makes one pass for each connection, all side by side, so a slow source never holds back a different source:

- Each pass locks the checkpoint of each incremental copy, opens one load on the destination, and prepares each target before it reads.
- A copy whose target refuses it (the target of a different writer, or a reader view that the load did not make) fails and reads nothing.
- A prepare publishes nothing. A target shows no later than the first commit of its stream.
- One read then covers the copies that are left.
- As in Airbyte, each copy runs also when a different copy fails, and the pass of each connection runs also when the pass of a different connection fails.
- Each stream stages its operations apart from the others and commits them at its own checkpoints. Thus an incremental copy that fails keeps what it committed, and it publishes nothing that it staged after its last commit.
- A full refresh commits one time, when its stream ends, so a failure keeps the earlier target. An empty overwrite empties the target. An empty append keeps the records that are there.
- There is no rollback across the pipeline.

When a copy is not complete, `run()` throws one `PipelineError` after each pass ends:

```ts
import { PipelineError } from '@eltjs/elt';

try {
  await pipeline.run(); // [{ copy, count, deleted }] when every copy completed.
} catch (error) {
  if (!(error instanceof PipelineError)) throw error; // Preflight and history errors are direct.
  // error.results contains committed counts and stream/partition failures.
  // error.cause is the first failure.
  process.exitCode = 1;
}
```

- `PipelineError` is an `AggregateError`. `errors` holds each failure. `results` holds the committed `count` and `deleted` of each copy beside its `failures`, in the order of the connections, then of the copies. Each failure has its `partition`, `error` and [`failureType`](#failure-types).
- The `message` of `PipelineError`, and the error that `passError` gives the sync history, names each distinct failure message once, with each copy and partition that failed with it. Thus a store that refuses five streams gives its remedy once: `The following copies did not load completely: calls, contacts: Turn on … Full Disk Access.; notes: The store is corrupt.`
- A failure after rows committed, such as a checkpoint that the store could not save or a cleanup error after the publication, shows in the same way, with the committed counts. It does not mean a rollback.
- A count of zero also covers an empty input that committed.
- A `PipelineError` holds only failures that the sync history recorded. A pass that could not run, such as a pass whose sync history the pipeline could not write, is recorded nowhere. Thus `run()` rejects with that error itself, after each other pass ends.
- When the history cannot record why a connection failed its validation, `run()` and `watch()` reject with a `SuppressedError`. Its `error` is the error of the history, and its `suppressed` is the error of the validation.

`run({ signal })` stops a run on request, as Airbyte cancels a sync:

- When the signal aborts, each pass applies no more messages. Each copy that still reads drops what it staged after its last commit, keeps what it committed and the checkpoints that it saved with it, and ends `cancelled`. A copy that ended before keeps its outcome.
- The [sync history](#sync-history) records the pass as `cancelled`, with the reason of the signal as its error. Then `run()` rejects with `signal.reason`, as `fetch` does.
- `Source.read(catalog, states, signal)` gives the signal to `open(streams, signal, states)` and to each `extract` after its context. Thus a source that waits for its upstream can stop at once. A source that ignores it stops at its next message.
- A [snapshot diff](#snapshot-streams) yields no message while it finds no change, so it stops itself at the next record or group.

The destination contract:

- Declarations are frozen, and you can use them again.
- `Destination.createWriter(configuration, target)` selects a strategy of the storage with no I/O.
- `Destination.load({ clock, connection })` opens the one hold of the pass on the storage. `connection` is the name of the connection whose pass opens it, so a destination that records its loads can name each one.
- `load.prepare(configuration, target, { writer, reloading })` gives each stream its `Stage`. A `Stage` has `apply`, `commit` and `discard`. It also has `fresh`, which is true when the target holds none of the earlier rows of the copy, so the copy reads from no checkpoint; `reloading`, which is true while commits go to a hidden target; and `complete`, which puts that hidden target in the place of the target after the stream ends with no failure.
- `Destination.failureType(error)` gives the [failure type](#failure-types) of each error that the destination raised. Each destination must implement it.
- Each destination uses `reloadMode` to decide what to do with the target: load into it, make it, evolve a stored target that the stream does not fit now ([shape changes](#shape-changes)), open a reload for an overwrite whose stored target does not fit now, or continue the reload that the last run of the copy left open. A `RESET` of the full stream also opens a reload.
- Destinations own connections, files and publication. `Copy` and `Pipeline` have no SQL or file system code of a load.
- `Source.identity` and `Destination.location(target)` give stable checkpoint bindings. The scope of a stored file is the location of the target, the writer of the copy and the file field.
- The identity of a source names what it reads, its kind and what changes which records exist (`sql-server:<database>`). It never names where its store is. Thus a store that moves to a different Mac or home folder keeps its checkpoints. A host that reads a second store of one kind keeps it apart with its own checkpoint store.
- A custom destination names each stored object by its address in the destination, never by where the destination is.

The locks and commits of each destination are in [elt-sqlite](../destinations/sqlite/README.md#locks-and-commits) and [elt-postgresql](../destinations/postgresql/README.md#locks-and-commits).

Live check on 2026-09-26 (macOS 26.6.2): the Apple exporter ran two times against the real stores.

- The first run loaded each stream (Messages 12,573 messages, Calendar 10,941 events) in 203 s.
- The second run took 168 s. It wrote nothing for Notes, Messages, Contacts and Reminders. For Calendar it wrote only 2 events (with 1 alarm and 2 recurrence rules) that had just come into its window of one year, and 1 account that EventKit listed for the first time.
- A run that was killed while it wrote published nothing that it staged.
- The Search Console exporter loaded each stream into the Postgres warehouse on the same day.

## Sync history

As the platform of Airbyte keeps the jobs and attempts of each connection apart from each connector, the orchestrator records each pass in a `SyncHistory`, from `elt`. Like a `CheckpointStore`, it belongs to the orchestration. Give it as `Pipeline({ connections, history })`. The SQLite history is in [elt-sqlite](../destinations/sqlite/README.md#sync-history), and the Postgres history is in [elt-postgresql](../destinations/postgresql/README.md#sync-history).

The contract:

- `validate(connection)` refuses, with no I/O, a connection that the history cannot record. The pipeline calls it when it validates.
- `install(connections, at)` brings the storage of the history to its declaration. The pipeline calls it when it validates, after `validate` and before a read, on each run and watch. Thus no host calls it, and it is safe to repeat. See [ADR 0013](./docs/adr/0013-the-pipeline-installs-its-sync-history-before-each-run-and-watch.md).
- `begin(connection, copies, at)` gets each selected copy with its `coverage`. It is durable when it resolves, before the read starts. Thus a pass that never ends stays visible as unfinished, not missing.
- `begin` returns a `RecordedPass`. `finish(outcomes, upstream, at)` closes it with what each copy loaded and, for each stream, when its source told that its upstream was last current. `fail(error, failureType, at)` closes a pass that gave no outcomes, such as a connection that is not valid or a failed change signal.
- A `RecordedPass` is `AsyncDisposable`. The pipeline disposes it when the pass ends, with an outcome or not. Thus a history can hold what shows that a pass still runs. For example, the Postgres history holds a session with a lock on the attempt ([elt-postgresql ADR 0009](../destinations/postgresql/docs/adr/0009-a-running-attempt-holds-a-lock-of-its-session.md)). The SQLite history holds nothing and disposes nothing.
- A pass ends `succeeded`, `partial`, `failed` or, when the signal of its run stopped it, `cancelled`.
- A history does not read a clock. `at` is the time of the event, which the pipeline reads from its clock: the start of a pass, its end, or the install. A history records `at`, not the time of its database, so the times of a pass and of a check come from one clock. See [ADR 0019](./docs/adr/0019-a-pipeline-waits-and-reads-the-time-on-the-clock-that-its-caller-gives.md).
- A subclass implements `recordChecks(connection, checks)`, which is durable when it resolves. Each check is a `StreamCheck`, `{ stream, at }`. `checked()` calls it for the first check of a connection at once, and then at most one time each minute, because each record is a write.
- Readers see the history through the relations of `syncHistoryRelations`, which both histories publish with the same descriptions: `sync_attempts`, `extraction_coverage`, `sync_status`, `stream_status` and `derived_status`. A pass that succeeded says nothing of the derived data: each view and computed dataset writes its own row of `derived_status` at each refresh, with its state, the time that its data is as of, and for a computed dataset how many inputs it has still to compute. See [ADR 0025](./docs/adr/0025-each-derived-dataset-tells-readers-how-current-it-is.md).
- The helpers `copyStatus`, `passStatus`, `passError` and `passFailureType` get from the outcomes the status (`SyncStatus`), the error text and the failure type of a copy or a pass. `recordedFailure` makes the failure entry that the two histories store. `errorMessage` gives the message of a thrown value: the message of an `Error`, or the value as a string. `DeclaredCopy` and `RecordedPass` type the contract.

```ts
import {
  PostgresCheckpointStore,
  PostgresDestination,
  PostgresSyncHistory,
} from '@eltjs/elt-postgresql';

const url = 'postgres://warehouse:warehouse@127.0.0.1:55432/warehouse';
const warehouse = new PostgresDestination({ url });

const history = new PostgresSyncHistory({ url });

const recorded = new Pipeline({
  history,
  clock: globalThis,
  connections: [
    new Connection({
      name: 'apple-notes',
      source: notes,
      destination: warehouse,
      checkpoints: new PostgresCheckpointStore({ url }),
      steps: [
        new Copy(notes.notes, warehouse.table('notes'), {
          id: 'apple-notes:notes',
          syncMode: 'incremental',
          destinationSyncMode: 'append_dedup',
        }),
      ],
    }),
  ],
});
```

### Pass channels

Each pass publishes what it does on `node:diagnostics_channel` channels, as Node asks a module to do (`doc/api/diagnostics_channel.md`) and as Got and undici do for their requests. To show passes while they run, for example in a terminal, subscribe to `passChannels`:

| Channel                                       | Message        | When                                                                                                                                                                                         |
| --------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `passChannels.start` (`elt:pass.start`)       | `PassStarted`  | The history recorded the start of the pass.                                                                                                                                                  |
| `passChannels.progress` (`elt:copy.progress`) | `CopyProgress` | A copy changed: its `status` (`running`, then one time `complete` or `incomplete`), and the records and deletions that the source `emitted` and that the destination `committed` until then. |
| `passChannels.finish` (`elt:pass.finish`)     | `PassFinished` | The history recorded the `outcomes` of the pass.                                                                                                                                             |
| `passChannels.failure` (`elt:pass.failure`)   | `PassFailed`   | The history recorded why a connection gave no pass, with its `error` and `failureType`.                                                                                                      |

```ts
import { AsyncLocalStorage } from 'node:async_hooks';

import { CopyProgress, passChannels } from '@eltjs/elt';

const scope = new AsyncLocalStorage<string>();
passChannels.progress.subscribe((message) => {
  if (message instanceof CopyProgress && scope.getStore() === 'mail')
    console.log(
      message.copy.from.name,
      message.status,
      message.committed.count,
    );
});
await scope.run('mail', () => pipeline.run());
```

- A subscriber gets each message as `unknown`, and tells it by its class.
- Each message has its `connection`. A host that runs several pipelines in one process tells its own passes by their async context: it runs each in an `AsyncLocalStorage`, because Node calls a subscriber in the async context of the publisher.
- The pass runs in the stores that subscribers bind to `passChannels.start` (`passChannels.start.bindStore(store)`): the pipeline starts the pass with `runStores`. Thus a subscriber's `store.getStore()` gives the pass's `PassStarted` in every message that the pass publishes, as the crawls of the pass publish theirs. An OpenTelemetry subscriber uses it to make a crawl's span a child of its pass's span.
- The pipeline does not wait for a subscriber. A subscriber that throws does not stop the pass, but Node reports the error as an uncaught exception, so a subscriber catches its own errors.

### Failure types

Each failure tells whose it is to fix, as the `failure_type` of Airbyte does (`AirbyteTracedException`, `airbyte-python-cdk` `utils/traced_exception.py`). See [ADR 0012](./docs/adr/0012-every-failure-says-whose-it-is-to-fix.md) and [ADR 0029](./docs/adr/0029-the-side-that-raised-a-failure-names-its-type.md).

- Each `LoadFailure` has a `failureType`. The side that raised the error decides it with `failureType(error): FailureType`.
- The destination decides for each error that a call into it throws: its `load`, the `prepare` and the dispose of its `Load`, and each call of a `Stage`.
- The checkpoint store decides for each error that it throws while it opens the checkpoints of a run, and while it reads or saves one of them.
- A file storage decides for each error that its `save`, `flush` or `retain` throws. A read of the file content of the source inside a `save` stays the source's.
- The source decides for each other error: its read, a message that breaks the contract, and a failure that ends a connection before a pass, such as a declaration that is not valid or a change signal that failed.
- `config` means that the upstream or the destination refused what the user set up or granted, so only the user can fix it. `system` is for each other error.
- `Destination.failureType`, `CheckpointStore.failureType` and `FileStorage.failureType` are abstract, so each side decides for its own errors. The destinations of this repository say which errors of the destination and of its checkpoint store are `config` in their READMEs.
- A source lists in `configErrors` the error classes that mean `config`. The default `failureType` returns `config` for an instance of a listed class and `system` for each other error. Thus a source that lists nothing calls each failure `system`.
- The Apple sources list the `*UnavailableError` of their SDKs (the macOS access that the store of the app needs). SQL Server lists its permission and connection errors.
- A source that decides from more than the class overrides `failureType`. Search Console maps a `401` or `403` from Google.
- `sync_attempts` and `sync_status` hold the `failure_type` of the pass: `config` when any failure is `config`, `system` for a pass that failed in a different way, and NULL after success, while it runs, or when it was cancelled. Each entry of `extraction_coverage.failures` holds its own.
- Hosts add access guidance only to a `config` failure. A [watch](#watch-for-changes) loads again only a stream that failed for a `system` reason.
- elt has no `transient_error`, because nothing reads it yet.

Each failure in `extraction_coverage.failures` keeps a `stacktrace` beside its `error` message. The stacktrace is the error as Node renders it, with its stack and each `cause` that it chains. A download that failed on the network has the message `fetch failed`, and its stacktrace tells why, for example `[cause]: Error: connect ECONNREFUSED 127.0.0.1:443` with `code: 'ECONNREFUSED'`. Airbyte keeps the same split: each `FailureReason` of the failure summary of an attempt has a short message and a separate `stacktrace` (`airbyte-platform` `FailureHelper.kt`), and its Python traceback has the chained causes. Each entry is `{ partition, error, failure_type, stacktrace }`:

```sql
SELECT c.stream, json_extract(f.value, '$.error') AS error, json_extract(f.value, '$.stacktrace') AS stacktrace
FROM extraction_coverage c, json_each(c.failures) f
WHERE c.attempt_id = (SELECT max(attempt_id) FROM sync_attempts);
```

### Coverage

Coverage is what the source tells about its own scope: `coverage(stream): ExtractionCoverage`, with `ExtractionCoverage = { description, selection }`. It is what a pass over that stream asks the upstream for, from the configuration of the source (`startAt` and `endAt` of Calendar, `siteUrls` of Search Console). It never comes from the records that the pass finds. `selection` holds the JSON configuration values that the description refers to. Each custom source implements it.

- Coverage is the **configured scope**. It is not the minimum or maximum dates that the pass saw, and it does not prove that the upstream is complete.
- Each source tells its coverage in its README, for example [Calendar](../sources/apple/calendar/README.md#coverage), [Activity](../sources/apple/activity/README.md#coverage), and `localAppleStoreCoverage` of [source-apple-macos](../sources/apple/macos/README.md#coverage), which most Apple sources share.

### How current a stream is

A source also tells how current the upstream of each stream is, with `currentAsOf(stream): Promise<Date | null>`. A replica reports the last change that it replayed (`pg_last_xact_replay_timestamp()`), and a Beam source reports its watermark, in the same way. See [ADR 0014](./docs/adr/0014-a-source-says-how-current-each-stream-s-upstream-is.md).

- `null` means that the upstream is current each time that the source reads it. Each source gives its answer. None inherits it.
- A `Date` means that the upstream itself was current only as of that time. For example, the store of an app that the app writes only while it runs stays as of the last write of the app.
- The pipeline asks before each pass and records the answer with each copy that loads. `current_as_of` is never later than that time.
- A copy whose source cannot tell fails with that error and is not read. The other copies of the pass load.
- Airbyte has no such statement. Its "Data fresh as of" is the time when its last sync ended.

Each source tells its answer in its README. Most sources answer `null`. These answer with a time:

- [Notes](../sources/apple/notes/README.md#watch), [WhatsApp](../sources/whatsapp/desktop/README.md#watching) and [Safari](../sources/apple/safari/README.md#how-current-the-streams-are): the last write of the store while the app is closed, because only the app syncs it.
- [Slack](../sources/slack/desktop/README.md#watching), [Teams](../sources/microsoft/teams/README.md#watching) and [Mail](../sources/apple/mail/README.md#watching): always the last write of the store.
- [Wallet](../sources/apple/wallet/README.md#changes-and-deletions): the last iCloud fetch of passd.

### The four clocks

Four clocks have different meanings:

- The modification fields of a source record tell of changes in the upstream.
- `loaded_at` tells of the load that last wrote a row. It is the one column of its own that a destination shows to readers: a reader view shows the columns of the stream and `loaded_at`, now and as of a position. The other columns of the destination are internal ([SQLite](../destinations/sqlite/README.md#columns), [Postgres](../destinations/postgresql/README.md#reader-views)).
- `last_successful_sync_at` tells when a recorded pass ended.
- `current_as_of` tells when a stream last agreed with its upstream: the start of its last successful pass, or a later watch check that found it unchanged. It is never later than when its source tells that the upstream itself was last current. Use it to judge freshness.

What the history does not prove:

- Table timestamps and the end of a pass do not tell that a watch still checks its upstream.
- An attempt that stays `running` means only that its end was not recorded, also after a process stopped or could not keep its outcomes.
- The metadata and the commits of the destination are separate. Metadata that did not end never tells of success.
- The set up of credentials or of a source before the pipeline is made is not part of the recorded attempt.
- Missing metadata means unknown. It does not mean empty or current.

## Declare derived datasets on the pipeline

```ts
import { DocumentText, LocalFiles, Pipeline } from '@eltjs/elt';
import { ComputedDataset, SQLiteSyncHistory, View } from '@eltjs/elt-sqlite';
import { MacOSDocumentParser } from '@eltjs/source-apple-macos/macos-document-parser';

const pipeline = new Pipeline({
  history: new SQLiteSyncHistory(),
  connections: [connection],
  derived: [
    // Computed on write: a rule makes one output for each stored file.
    new ComputedDataset({
      into: sqlite,
      name: 'document_text',
      description: 'The text of each stored document.',
      from: [documents],
      compute: new DocumentText({
        parser: () => new MacOSDocumentParser(),
        files,
        column: 'documentRef',
      }),
    }),
    // Computed on read: SQLite runs the query at each read.
    new View({
      into: sqlite,
      name: 'document_count',
      description: 'How many documents loaded.',
      columns: { n: 'Number of documents.' },
      sql: 'SELECT count(*) AS n FROM documents',
    }),
  ],
});
```

`connection` copies a stream into the table `documents`, and `files` is the `LocalFiles` that keeps its stored files, which `DocumentText` reads through it. Each kind of derived dataset is a class of a destination package. The SQLite, Postgres and SQL Server destinations each have `View` and `ComputedDataset`; see [elt-sqlite](../destinations/sqlite/README.md), [elt-postgresql](../destinations/postgresql/README.md#declare-a-computed-dataset) and [elt-sqlserver](../destinations/sqlserver/README.md#declare-a-computed-dataset). See [ADR 0001](./docs/adr/0001-derived-data-is-declared-on-the-pipeline.md).

## When the pipeline refreshes

- **Each commit** of a copy asks for a refresh in the background, in a run and in a watch. Thus a long pass shows its derived data while it reads, from what its checkpoints committed. One refresh runs at a time. A commit while a refresh runs asks for one more refresh after it. No pass waits for a refresh. See [ADR 0017](./docs/adr/0017-each-commit-asks-for-a-refresh.md).
- **A run** waits for the refresh that runs after its passes, and then refreshes each derived dataset one more time, also when some copies or datasets failed. Then a dataset whose last refresh failed rejects the run, as itself; else a copy that did not load completely rejects it with `PipelineError`. See [ADR 0002](./docs/adr/0002-a-run-refreshes-its-derived-data-also-when-copies-failed.md).
- **A watch** also asks for a refresh after each pass. See [ADR 0003](./docs/adr/0003-a-watch-refreshes-in-the-background-one-refresh-at-a-time.md).
- **A failed dataset** waits for the refresh after the next pass. A refresh for a commit does not try it again. Thus a dataset that always fails is tried once for each pass. See [ADR 0031](./docs/adr/0031-a-dataset-failure-fails-only-its-dataset-and-a-watch-gives-it-beside-its-passes.md).
- The pipeline refreshes the derived datasets in the order of the list. A view that comes after a computed dataset can read the view of that dataset.
- A run does not refresh after an abort, or after an error that no sync history recorded. A stop that comes after the passes only stops the refresh. The next refresh continues the work.

## Declare a composite dataset

A `CompositeDataset` is one declaration that makes many derived datasets, its members, for one job. For example, the `Vectorizer` of [`@eltjs/vectorizer`](../vectorizer/README.md) makes the chunks, the keyword index, the passages and the vectors of a table. A class that extends `CompositeDataset` gives:

| Member                  | Gives                                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `name`                  | the name of the composite, which a failure gives                                                      |
| `members`               | one or more derived datasets, in the order they refresh in. A member reads only the members before it |
| `validate(connections)` | optional: refuses, with no I/O, a declaration that the copies of the pipeline cannot feed             |

The pipeline takes a composite in `derived`, beside other derived datasets:

- `pipeline.derived` gives the members of each composite in its place.
- The name of the composite and the name of each member must be distinct from all other names of `derived`. Else the run or the watch rejects with a `TypeError` before it reads.
- The pipeline validates the composite, and then each member.
- The members refresh in order. A dataset after the composite finds each member in `earlier`, so a view that reads a member waits while the member waits.
- A composite fails as one dataset. The first member that fails stops the members after it, and the refresh after the next pass tries the composite again from its first member. Each member keeps its own row of `derived_status`. The error names the member: a watch yields `{ kind: 'refresh', dataset: <composite>, error }` where `error` is the `DerivedDatasetError` of the member, and a run rejects with the `DerivedDatasetError` of the composite, whose `cause` is that of the member.
- A member cannot be a composite.

See [ADR 0034](./docs/adr/0034-a-composite-dataset-refreshes-its-members-in-order-as-one-dataset.md). The recipe [Write a composite dataset whose members refresh in order](./docs/recipes/write-a-composite-dataset.md) gives a full program.

## Write a rule

A computed dataset gives each input to its rule. A rule is a class that extends `Rule<Input, Columns>`, where `Columns` is the type of its `output`:

| Member                    | Gives                                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| `key`                     | the name and the description of the key column, for example `ref`                                    |
| `output`                  | the rule columns that the rule adds to each output, each with its kind and a description             |
| `batch`                   | how many inputs one call of `compute` takes, for example the texts of one model call                 |
| `concurrency`             | how many calls of `compute` run at the same time, for example files that are parsed side by side     |
| `read(row)`               | the key and the input of one loaded row, or `null` when the row has no input                         |
| `identity(input)`         | the rule identity of the input, or `null` when the rule does not handle it                           |
| `compute(inputs, signal)` | one output for each input, in order: `{ value }`, `{ empty: true }`, `{ error }` or `{ gone: true }` |

The dataset makes an output again when its input or its rule identity changes. See [ADR 0005](./docs/adr/0005-an-output-is-made-again-when-its-rule-identity-changes.md). The recipe [Write a rule and a table rule, and compute a dataset with them](./docs/recipes/write-a-rule-for-a-computed-dataset.md) gives a full program.

Each rule column has a kind. The kind sets the type of the value that `compute` gives for the column, so a rule that gives a string to a vector column does not compile:

| Kind                                   | Value                                       | SQLite    | Postgres       | SQL Server       |
| -------------------------------------- | ------------------------------------------- | --------- | -------------- | ---------------- |
| `{ type: 'text' }`                     | `string`                                    | `TEXT`    | `text`         | `nvarchar(max)`  |
| `{ type: 'blob' }`                     | `Uint8Array`                                | `BLOB`    | `bytea`        | `varbinary(max)` |
| `{ type: 'integer' }`                  | `number`, a safe integer                    | `INTEGER` | `bigint`       | `bigint`         |
| `{ type: 'vector', dimensions: 1536 }` | `Vector` of `@zukhruf/vectors`, 1536 values | `BLOB`    | `vector(1536)` | `vector(1536)`   |

```ts
const columns = {
  tokens: { type: 'integer', description: 'The tokens of the text.' },
  vector: {
    type: 'vector',
    dimensions: 1536,
    description: 'The text as a vector.',
  },
} as const;

class Chunks extends Rule<string, typeof columns> {
  override readonly output = columns;
  // compute gives { value: { tokens: 12, vector: Vector.from(values) } }
}
```

A column with no value is `NULL`. SQLite keeps a vector as the bytes of `toSql` of `@zukhruf/vectors/sqlite`: float32 values, little-endian. Postgres keeps it as a `vector(n)` of pgvector, and sends it as the text of `toSql` of the npm package `pgvector` (55bb5503). SQL Server keeps it as a `VECTOR(n)` of float32 values, of at most 1,998 dimensions, and sends it as the JSON text of `toSql` of `@zukhruf/vectors/sqlserver`. A value that does not fit its column is a rule failure of its input, with an error that names the column: an integer that is not a safe integer, or a vector of other dimensions than its column, with both counts. A `Vector` holds only finite values, so a vector with `NaN` or `Infinity` fails in the rule, where the rule makes it.

Two rules exist:

| Rule                                            | Package            | Input                                                      | Output                                                                                                                                               |
| ----------------------------------------------- | ------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DocumentText({ parser, files, column })`       | `@eltjs/elt`       | the ref in `column`, which the `FileStorage` `files` opens | `content`, the text that a `DocumentParser` reads. The rule identity is the parser of the format of the file                                         |
| `Embedding({ model, dimensions, key, fields })` | `@eltjs/embedding` | the text of `fields`, with a line break between them       | `vector`, a vector column of `dimensions`, from an AI SDK embedding model. The rule identity is the provider, the id of the model and the dimensions |

`rowText(row, fields)` gives the text of `fields` of a loaded row, with a line break between them, as `Embedding` and `Chunking` read it. A field that has no text, or only white space, is not in it. A row with no text in any field gives `null`. A rule of your own can read its input with it.

`DocumentText` asks for its parser at each refresh, so a parser that the host changed, for example a new speech model, applies from the next refresh.

`DocumentText` opens each file with `files.open(ref)`, gives the path to the parser, and disposes the file after the parse. A file that rows name and that `files` does not hold is a failure of its row, with the message of the `StoredFileMissingError` of the storage. This is also true when `identityFor` reads the `head` of that file: the `rule` of the row is then the identity of the parser. Each other error of `open`, such as a folder that this process may not read, is a failure of the storage, so the refresh fails. The error of `LocalFiles` names the folder and the ref, and tells you to reload the copy that stored the file. For example, a host that moves to a new disk keeps its rows, but the folder on that disk has no files, so each file that the dataset reads again fails. A file that a commit removed with its rows while the refresh read it also fails its row, and the refresh that the commit asks for then removes that row.

## Write a table rule

A table rule gives one or more parts for one input, as a table function of SQL gives rows. For example, a rule cuts a long text into chunks that an embedding model can take. A table rule is a class that extends `TableRule<Input, Columns, Place>`. It has the members of a rule, and one more group of columns:

| Member                    | Gives                                                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `output`                  | the content columns of each part: what the part is, for example its text. The part hash covers them                        |
| `place`                   | the place columns of each part: where the part is in its input, for example its offsets. The part hash does not cover them |
| `compute(inputs, signal)` | one result for each input, in order: `{ parts }`, `{ empty: true }`, `{ error }` or `{ gone: true }`                       |

`parts` holds one or more parts in order, each with the values of both groups. A list of no parts does not compile: an input with no parts is `{ empty: true }`.

```ts
const content = {
  text: { type: 'text', description: 'The text of the piece.' },
} as const;
const place = {
  start: { type: 'integer', description: 'Where the piece starts.' },
} as const;

class Lines extends TableRule<string, typeof content, typeof place> {
  override readonly output = content;
  override readonly place = place;
  // compute gives { parts: [{ text: 'one', start: 0 }, { text: 'two', start: 4 }] }
}
```

The `ComputedDataset` of elt-sqlite, elt-postgresql and elt-sqlserver takes a `Rule` or a `TableRule` in `compute`. For a table rule, the dataset keeps one output row for each key, with no rule column, and one row for each part, with the key, `seq`, `part_hash`, the content columns and the place columns. See the README of each destination for its parts table, and [ADR 0026](./docs/adr/0026-a-rule-can-give-many-parts-for-one-input.md).

- `seq` is the order of the part in its input, from 0.
- `part_hash` is the SHA-256, in lowercase hex, of the content columns of the part. It does not cover `seq` or the place columns, so a part that only moved keeps its part hash. Each content column that has a value counts, in the order of the names as JavaScript sorts them: first `c<n>:<name>`, then the value as `<tag><n>:<bytes>`, where `<n>` is the count of bytes in decimal. The tag is `t` with the UTF-8 bytes of a text, `n` with the decimal digits of an integer, `b` with the bytes of a blob, or `v` with the float32 values of a vector, little-endian. A column with no value does not count. elt computes the part hash, so each destination keeps the same part hash for the same part.
- The output row and its parts are written in one commit. A part with the same values as the stored part of its key and `seq` keeps its commit. A changed part is written. A stored part with a `seq` past the new parts is deleted. An output row that is `empty` or `failed` has no parts, and the deletion of an output row deletes its parts.
- A value of a part that does not fit its column fails the input, with an error that names the part and the column, for example `Part 0: The column start takes a safe integer, and the rule gave 0.5.`
- `derived_status` counts the output rows, one for each key. `pending` counts the inputs, not the parts.

## Write a kind of derived dataset

A rule gives one output row for each key. When the output of a dataset is not one row for each key, write a kind of derived dataset that makes its data itself. For example, the `KeywordIndex` of [`@eltjs/vectorizer`](../vectorizer/README.md) keeps an FTS5 index of the passages in one transaction (`packages/vectorizer/src/sqlite/keyword-index.ts`), and the `Reports` of what-is-going-on put each crawled article in an event again at each refresh. A kind is a class that extends `DerivedDataset<Target>` (`src/core/derived-dataset.ts`):

| Member                                                      | Gives                                                                                     |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `name`                                                      | the name of the dataset, which a failure gives                                            |
| `validate(connections)`                                     | optional: refuses, with no I/O, a declaration that the copies of the pipeline cannot feed |
| `refresh({ connections, clock, earlier, signal, trigger })` | brings the data in step with what the copies committed. It is safe to repeat              |

The arguments of `refresh`:

- `connections` are the connections of the pipeline. A kind finds in them the copies that make the relations that it reads.
- `clock` is the clock of the pipeline. It gives the time of each change that the refresh makes.
- `earlier` holds the derived datasets that this refresh follows, in the order of the list. Thus a dataset that reads one of them can tell an input that still waits from an input that the pipeline never makes.
- `signal` is the signal of the run or the watch. A refresh that a stop ended is not a failure.
- `trigger` is a `RefreshTrigger`, why the pipeline refreshes: `{ kind: 'commit', tried }` after a commit of a copy, or `{ kind: 'pass', tried }` after the passes. `tried` holds the keys that the commit refreshes of these passes tried. A commit refresh adds to it. A pass refresh tries again what failed, except these keys, which wait for the next pass. Thus a failing input is tried at most once for each pass. A kind with no keys does not read it.

The rules of a kind:

- A refresh can run while a copy loads, so it reads only what committed.
- An error that `refresh` throws is a [dataset failure](#when-a-derived-dataset-fails). The kind writes its own row of `derived_status`: `refreshing`, `current`, `waiting` or `failed`. Each destination gives the parts that its own kinds use, such as the writer of that row: see [elt-sqlite](../destinations/sqlite/README.md#write-a-kind-of-derived-dataset-in-another-package), [elt-postgresql](../destinations/postgresql/README.md#write-a-kind-of-derived-dataset-in-another-package) and [elt-sqlserver](../destinations/sqlserver/README.md#write-a-kind-of-derived-dataset-in-another-package).
- The pipeline takes a kind in `derived`, beside views, computed datasets and composite datasets. The type of each item of `derived` is `DeclaredDataset<Target>`: a `DerivedDataset` or a `CompositeDataset`.

The recipe [Write a kind of derived dataset whose output is not one row for each key](./docs/recipes/write-a-kind-of-derived-dataset.md) gives a full program.

## When a derived dataset fails

- **A rule failure** is the output of its input: the status `failed` and the reason. The load and the run continue, and the next refresh tries the input again. See [ADR 0004](./docs/adr/0004-a-rule-failure-stays-on-its-output.md).
- **A dataset failure**, for example SQL that SQLite refuses, fails only its dataset. The dataset records `failed` and the error in `derived_status`. The other datasets still refresh in the order of the list, and the passes go on. A dataset that reads the failed one reads what the failed one made last. No sync history records a dataset failure. See [ADR 0031](./docs/adr/0031-a-dataset-failure-fails-only-its-dataset-and-a-watch-gives-it-beside-its-passes.md).
  - A watch yields a `DatasetFailure`, `{ kind: 'refresh', dataset, error }`, when the dataset starts to fail. `dataset` is its name, and `error` is its own error, for example the error of the store. While the dataset keeps failing, the watch yields no more failures for it. After a refresh of it ends with no failure, a new failure is yielded again.
  - A run rejects after its last refresh when the last refresh of a dataset failed. When one dataset failed, the run rejects with its `DerivedDatasetError`: its `dataset` names the dataset, and its `cause` is the error of the store. When more than one failed, the run rejects with a `DerivedDatasetsError`, an `AggregateError` whose `errors` holds the `DerivedDatasetError` of each, in the order of the list. A dataset failure comes before a `PipelineError`: no sync history records it, so the run rejects with it also when copies failed. The sync history still records the copies that failed.
  - A view that reads a view declared after it fails its first refresh, while the later view is not there yet. The refresh after the passes tries it again, and then the later view is there.
  - A refresh that the stop of a run or a watch ended is not a failure.
- **A copy that failed** keeps its last committed rows. The derived data of those rows stays as it was.

## Positions of a destination

A destination that numbers its commits gives positions, so a reader can read it as of a commit where no pass is half done. The destination reads its numbering from its own store, and `@eltjs/elt` gives the rules that each destination applies to it:

- `numbering({ epoch, minValid, expiredBy, settled, spans })` finds the positions from the first and last commit of each load, with a sweep line: an end is a position when no load that began at or before it ends after it. An open load has `last: null` and reaches past every later commit. Only the positions from `minValid` to the high-water mark `settled` are kept.
- `parsePosition(text, store)` reads `<epoch>:<number>`, and refuses other text with a `TypeError` that names the store, such as `{ engine: 'SQLite', noun: 'file' }`.
- `positionsAfter(numbering, since, store)` gives the positions after `since`, or each one, or `{ expired }` with the reason.
- `readingExpiry(numbering, position, store, where)` gives why a reading cannot read as of a position: of another epoch, past the high-water mark, or before `min_valid` and what set it (the retention, a change of type that is not a widening, or a clear). It throws a `TypeError` for a commit inside a pass.
- `readingNumber(numbering, asked, store, where)` gives the commit that a reading reads, with the numbering: the asked position after `readingExpiry`, or the newest position when none is asked. A store with no position gives `{ expired }`. The destination then reads that commit in its own snapshot.
- `staleness({ epoch, minValid, expiredBy }, position, store)` gives why a position that the store once had is no longer read exactly: of another epoch, or before `min_valid`. A reader that knows only these three values, such as a guard inside a view, asks it.

## Derived datasets of a destination

Each destination keeps its own `View` and `ComputedDataset`, and drives three rules of `@eltjs/elt` with its own storage:

- `refreshComputed({ rule, inputs, prepare, status, trigger, signal })` brings the outputs of a computed dataset in step with its inputs. The destination gives `inputs`, or `null` while a relation that the dataset reads is gone, and `prepare(keys)`, which makes the table match its declaration, removes each row whose key has no input, and gives the stored rows with `store`, `settle` and `counts`. Each write is one commit. The rule decides what is due: an input whose hash or rule identity changed, or a failed row on the refresh after the passes, each input at most once for each pass. It runs `rule.concurrency` calls of `rule.batch` inputs, and each call commits on its own. It fails each output whose value does not fit its rule column, so a destination gets only values that fit: it keeps each kind in its own form. The kind of the rule sets the rows that `prepare` takes: an `OutputRow` with the values of a `Rule`, or a `TableOutputRow` of a `TableRule`, whose computed row has its parts, each a `PartRow` with its part hash. An empty or failed row has no values and no parts. The destination writes the output row and its parts in one commit.
- `refreshView({ publish, missing, awaited, withdraw, status })` publishes a view, or lets it wait while the relation that the store's error names is one that a copy or an earlier derived dataset makes. While it waits, `withdraw` removes the view of its name that an earlier declaration made, as dbt drops a model's relation, so a view after it that reads it waits too. Any other error is the view's own failure.
- `DerivedStatus` gives the states of a row of `derived_status`: `waiting`, `refreshing` with counts, `current` with `as_of`, and `failed`. A destination writes the values in its `write`, and takes settled inputs off `pending` inside its own commit.
- `computedColumns` names the columns that each output row keeps beside the rule's own, with their descriptions.
- `DatasetIndex<Ordinary, Build>` is the type of an index that a computed dataset declares on one of its tables, which its destination makes at each refresh and drops when the declaration no longer has it: `{ type: Ordinary, columns }`, an ordinary index over key columns, or `{ type: 'vector', column, metric } & Build`, the index of the approximate search of one vector column. `metric` is a `VectorMetric`: `cosine`, `euclidean` or `dot`. Each destination gives the name of its ordinary index and the options of the build of its vector index: elt-sqlserver takes `DatasetIndex<'nonclustered', Record<never, never>>` (DiskANN), and elt-postgresql takes `DatasetIndex<'btree', { build: Hnsw }>`. Each destination refuses, names and reconciles its indexes itself ([elt-sqlserver ADR 0013](../destinations/sqlserver/docs/adr/0013-a-computed-dataset-declares-its-indexes-and-the-destination-reconciles-them.md), [elt-postgresql ADR 0011](../destinations/postgresql/docs/adr/0011-a-vector-column-is-a-pgvector-vector-with-declared-indexes.md)).
- `partsView({ dataset, description, rule })` gives the view that readers query the parts of a table rule through: its name `<dataset>_parts`, its description, and each column in table order with its description: the key, `seq`, `part_hash`, the content columns and the place columns.
- `reservedColumns(rule)` names the columns that no column of the rule may take, because the tables and the histories of the dataset keep them: the key, the computed columns, the part columns of a table rule, `committed_in`, `_elt_row_hash` and `replaced_in`. `refuseTakenColumns({ dataset, rule, reserved, key })` refuses a rule column, of either group of a table rule, whose name is in `reserved` or is the name of another rule column, and compares two names by `key`, as the store compares them. The constructor of each `ComputedDataset` calls it with `reservedColumns(rule)` and each other column that its destination keeps in the tables of the dataset.

The `readPassStatus` of a destination reads its sync history and gives a `PassStatus` of `@eltjs/elt`, with a `StreamPassStatus` for each stream. `combinedPass` shows the latest passes of several connections as one pass: it runs while one of them runs, and it is only as current as the least current one. `recordedPassStatus` gives the `PassStatus` of a row of the `sync_status` view, and `recordedStreamStatus` the `StreamPassStatus` of a row of `stream_status`; the destination gives each time as ISO text, and an unknown status or failure type is a `TypeError`.

## Errors

| Error                                       | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PipelineError`, an `AggregateError`        | `run()` rejects with it after each pass ends, when a copy did not load completely. `errors` holds each failure, `results` holds the committed counts and the failures of each copy, and `cause` is the first failure. See [Run and failures](#run-and-failures).                                                                                                                                                                                                                                 |
| `StreamChangeError`, a `TypeError`          | A failure of a copy, in `PipelineError.errors`: the stream of the copy changed a declaration since its checkpoint was saved. The message names the declarations. Reset the copy to keep its rows, or clear it to drop them. See [Shape changes](#shape-changes).                                                                                                                                                                                                                                 |
| `TargetOwnedError`, a `TypeError`           | A copy or a clear of a target that a different writer owns. The copy fails and reads nothing, and `pipeline.clear()` rejects. The message names the two writers. Clear the target with the copy that owns it. See [Target ownership](#target-ownership).                                                                                                                                                                                                                                         |
| `WatchError`, an `AggregateError`           | `watch()` rejects with it when each connection stopped, or the signal aborted, and connections stopped. Each error has the error that stopped its connection as its `cause`. See [Watch for changes](#watch-for-changes).                                                                                                                                                                                                                                                                        |
| `DerivedDatasetError`                       | `run()` rejects with it when the last refresh of one derived dataset failed, also when copies failed. `dataset` names the dataset, and `cause` is its own error, such as the error of the store. A watch does not reject: it yields a `DatasetFailure`. See [When a derived dataset fails](#when-a-derived-dataset-fails).                                                                                                                                                                       |
| `DerivedDatasetsError`, an `AggregateError` | `run()` rejects with it when the last refresh of more than one derived dataset failed. `errors` holds the `DerivedDatasetError` of each, in the order of the list.                                                                                                                                                                                                                                                                                                                               |
| `StoredFileMissingError`                    | `open(ref)` or `head(ref, length)` of a file storage, for a ref that the storage does not hold. `DocumentText` makes it a rule failure of its row. The message tells you to reload the copy that stored the file. See [Files in the database](#files-in-the-database).                                                                                                                                                                                                                           |
| `SuppressedError`                           | `run()` or `watch()` rejects with it when the sync history cannot record a failure. Its `error` is the error of the history, and its `suppressed` is the failure. See [Run and failures](#run-and-failures).                                                                                                                                                                                                                                                                                     |
| `TypeError`                                 | A declaration that is not valid, found before a read: connection names or copy IDs that repeat, a stream that a connection copies two times, pairs of modes that are not supported, missing keys, cursors, IDs or checkpoint stores, or a derived dataset name that repeats. Also a copy whose checkpoint binding changed, and a message that breaks the contract of its stream, such as a `StreamStatus` from `extract` or a deletion that the copy refuses: these fail the copy or the stream. |

## What the package does not do

- **elt has no full refresh that resumes.** A full refresh has no checkpoints. It commits one time, at the end, and a failure keeps the earlier target. See [Incremental copies and checkpoints](#incremental-copies-and-checkpoints).
- **elt has no query API and no general transform step.** Readers query the stored tables with SQL. The step after a load is a derived dataset: a view, a computed dataset with a rule, or a kind of its own. See [Attachment text](#attachment-text).
- **elt has no `transient_error`.** Nothing reads it yet. A failure is `config` or `system`. See [Failure types](#failure-types).
- **elt is not compatible with the wire protocol of Airbyte.** It uses the words of the platform of Airbyte, and a protocol in the process. The wire protocol enum of Airbyte does not have `overwrite_dedup`. See [Sync modes](#sync-modes).
- **The pipeline does not reconcile on a schedule, and it does not disable a connection.** A watch loads when a source reports a change, and it loads a stream again after a `system` failure. See [Watch for changes](#watch-for-changes).

## Who uses it

| Consumer                                                                                                    | How                                                                                                                                                                                                                                                                                                         | Record                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The Context Compiler CLI (`apps/cli` of [context-compiler](https://github.com/ezzabuzaid/context-compiler)) | Each connector builds a `Pipeline` that loads into a SQLite import of its own (`packages/connectors/connector/src/connector.ts`). The CLI subscribes to `passChannels`, and shows `PassStarted`, `CopyProgress`, `PassFinished` and `PassFailed` with `passStatus` and `passError` (`apps/cli/src/sync.ts`) | context-compiler commit `7fb669b`, which made `apps/cli`; the elt packages come from a checkout beside it ([context-compiler README](https://github.com/ezzabuzaid/context-compiler#sibling-checkout-of-elt)) |
| ipay (context-compiler `apps/ipay`)                                                                         | `Pipeline`, `Connection` and `Copy` over its own `Source`, `ImportsSource`, which diffs snapshots with `diffSnapshot`, and three `Rule` subclasses in `ComputedDataset`s of elt-sqlite                                                                                                                      | context-compiler commit `e30e754`                                                                                                                                                                             |
| websets (context-compiler `apps/websets`)                                                                   | `Pipeline` over its own `Source`, `DefinitionsSource`, and the `Rule` subclasses `Evaluation` and `FieldValue`                                                                                                                                                                                              | context-compiler commit `e9350c6`                                                                                                                                                                             |
| startup-credits (context-compiler `apps/startup-credits`)                                                   | `Pipeline`, and the `Rule` subclasses `PageKinds` and `ProgramOffers`                                                                                                                                                                                                                                       | context-compiler commit `a30ea48`                                                                                                                                                                             |
| what-is-going-on (context-compiler `apps/what-is-going-on`)                                                 | `Pipeline`, and `Reports`, a kind of derived dataset that extends `DerivedDataset`                                                                                                                                                                                                                          | #3205                                                                                                                                                                                                         |
| [`@eltjs/vectorizer`](../vectorizer/README.md)                                                              | `Vectorizer` extends `CompositeDataset`, and `KeywordIndex` extends `DerivedDataset`, for SQLite, Postgres and SQL Server                                                                                                                                                                                   | commit 86b42be2, [ADR 0034](./docs/adr/0034-a-composite-dataset-refreshes-its-members-in-order-as-one-dataset.md)                                                                                             |
| datahub (`packages/semantic-layer/elt`)                                                                     | `Pipeline` from npm (`@eltjs/elt` `^0.13.5`), with the SQL Server destination                                                                                                                                                                                                                               | #4348, #4738                                                                                                                                                                                                  |

## The same concepts in other systems

| Here                       | Elsewhere                                                                    |
| -------------------------- | ---------------------------------------------------------------------------- |
| Connection                 | A connection of Airbyte                                                      |
| Checkpoint                 | A state message of Airbyte, which is a commit point                          |
| Reset that keeps the rows  | A refresh of Airbyte that keeps records                                      |
| Clear                      | The Clear of Airbyte                                                         |
| Failure type               | The `failure_type` of Airbyte                                                |
| Current as of              | A Debezium heartbeat, or a Beam watermark                                    |
| Derived dataset            | Derived data (Kleppmann); a derivation (Estuary Flow); an asset (Dagster)    |
| View and computed dataset  | A dbt model that is materialized as a view, or as a table                    |
| Computed dataset with rule | A pgai vectorizer, which keeps an embedding of each row in step with the row |
| Rule identity              | The model of a pgai vectorizer: when it changes, pgai embeds the rows again  |
| Rule failure               | A row of `ai.vectorizer_errors` in pgai                                      |
| One refresh in the queue   | A build watcher, which keeps one rebuild in its queue while a rebuild runs   |

Airbyte has no step after a load. elt has one, because its hosts have no orchestrator.

## API

The public types of `src/index.ts`. Each `abstract` member is one that a subclass gives. The types of a destination's own work, at the end, are for the authors of a destination.

```ts
// @eltjs/elt

// The pipeline
type PipelineClock = Clock & { readonly Date: { now(): number } }; // Clock of @zukhruf/async; a host gives globalThis

class Pipeline<Target extends DestinationTarget> {
  constructor(options: {
    connections: readonly Connection<Target>[];
    history: SyncHistory<NoInfer<Target>>;
    derived?: readonly DeclaredDataset<NoInfer<Target>>[];
    clock: PipelineClock;
  });
  readonly connections: readonly Connection<Target>[];
  readonly history: SyncHistory<Target>;
  readonly derived: readonly DerivedDataset<Target>[]; // the members of each composite in its place
  run(options?: {
    readonly signal?: AbortSignal;
  }): Promise<CopyResult<Target>[]>;
  watch(options: { signal: AbortSignal }): AsyncGenerator<WatchEvent<Target>>;
  clear(steps?: readonly Copy<Target>[]): Promise<void>;
}
type Pass<Target> = {
  readonly kind: 'pass';
  readonly connection: Connection<Target>;
  readonly outcomes: readonly CopyOutcome<Target>[];
};
type WatchEvent<Target> = Pass<Target> | DatasetFailure;
class PipelineError<Target> extends AggregateError {
  readonly results: readonly CopyOutcome<Target>[];
}
class WatchError extends AggregateError {}

class Connection<Target extends DestinationTarget> {
  constructor(options: {
    name: string;
    source: Source;
    destination: Destination<Target>;
    steps: readonly Copy<NoInfer<Target>>[];
    checkpoints?: CheckpointStore;
  });
  validate(): void;
}

class Copy<Target extends DestinationTarget> {
  constructor(
    from: Stream,
    to: Target,
    modes?: {
      syncMode: SyncMode;
      destinationSyncMode: DestinationSyncMode;
      cursorField?: string;
      primaryKey?: readonly string[];
      dedupPolicy?: DedupPolicy;
      id?: string;
    },
  );
  readonly configuration: CopyConfiguration;
  readonly to: Target;
  readonly id?: string;
  get from(): Stream;
}
type WriteCount = { readonly count: number; readonly deleted: number };
type CopyResult<Target> = WriteCount & { readonly copy: Copy<Target> };
type CopyOutcome<Target> = CopyResult<Target> & {
  readonly failures: readonly LoadFailure[];
  readonly cancelled: boolean;
};
type LoadFailure = {
  readonly partition: Partition | null;
  readonly error: unknown;
  readonly failureType: FailureType;
};
type SyncMode = 'full_refresh' | 'incremental';
type DestinationSyncMode =
  'append' | 'overwrite' | 'append_dedup' | 'overwrite_dedup';
type DedupPolicy = 'cursor_newer' | 'replace';
class CopyConfiguration {
  readonly stream: Stream;
  readonly fileReads: readonly FileRead[];
  readonly syncMode: SyncMode;
  readonly destinationSyncMode: DestinationSyncMode;
  readonly cursorField?: string;
  readonly primaryKey?: readonly string[];
  readonly dedupPolicy?: DedupPolicy;
}
// Deduplication: the type of the key and the cursor of a deduplicating copy.

// Pass channels (node:diagnostics_channel)
const passChannels: { start; progress; finish; failure }; // elt:pass.start, elt:copy.progress, elt:pass.finish, elt:pass.failure
class PassStarted {
  readonly connection: Connection<DestinationTarget>;
}
class CopyProgress {
  readonly connection: Connection<DestinationTarget>;
  readonly copy: Copy<DestinationTarget>;
  readonly status: 'running' | 'complete' | 'incomplete';
  readonly emitted: WriteCount;
  readonly committed: WriteCount;
}
class PassFinished {
  readonly connection: Connection<DestinationTarget>;
  readonly outcomes: readonly CopyOutcome<DestinationTarget>[];
}
class PassFailed {
  readonly connection: Connection<DestinationTarget>;
  readonly error: unknown;
  readonly failureType: FailureType;
}

// Sources and streams
abstract class Source<Context extends AsyncDisposable = AsyncDisposable> {
  abstract readonly identity: string;
  protected abstract readonly catalog: Catalog;
  protected readonly concurrency: number; // 1 unless set
  protected readonly configErrors: readonly (abstract new (
    ...args: never[]
  ) => Error)[];
  discover(): Promise<Catalog>;
  validate(configuration: CopyConfiguration): void;
  read(
    catalog: readonly CopyConfiguration[],
    states: { get(stream: string): unknown },
    options: SourceReadOptions,
  ): AsyncGenerator<ReadMessage>;
  failureType(error: unknown): FailureType;
  abstract coverage(stream: Stream): ExtractionCoverage;
  abstract currentAsOf(stream: Stream): Promise<Date | null>;
  abstract changeSignals(
    streams: readonly Stream[],
    clock: PipelineClock,
  ): Iterable<ChangeSignal>;
  upkeep(clock: PipelineClock): Iterable<Upkeep>;
  protected abstract open(
    streams: readonly Stream[],
    signal: AbortSignal | undefined,
    states: { get(stream: string): unknown },
    clock: PipelineClock,
  ): Promise<Context>;
  protected partitions(stream: Stream): readonly Partition[];
  protected validateExtraction(configuration: CopyConfiguration): void;
  protected abstract extract(
    configuration: CopyConfiguration,
    state: unknown,
    partition: Partition | null,
    context: Context,
    signal: AbortSignal | undefined,
  ): AsyncIterable<SourceMessage>;
}
type SourceReadOptions = {
  readonly signal?: AbortSignal | undefined;
  readonly clock: PipelineClock;
};
type KeyValue = string | number | boolean;
type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [field: string]: JsonValue };
type RecordMessage = {
  readonly stream: string;
  readonly data: unknown;
  readonly file?: string | null;
};
type DeleteMessage = {
  readonly type: 'DELETE';
  readonly stream: string;
  readonly key: Readonly<Record<string, KeyValue>>;
  readonly cursor?: string | number; // only for a cursor_newer copy
};
type ResetMessage = { readonly type: 'RESET'; readonly stream: string };
type StateMessage = {
  readonly type: 'STATE';
  readonly stream: string;
  readonly state: unknown;
};
type SourceMessage =
  RecordMessage | StateMessage | DeleteMessage | ResetMessage;
type ReadMessage =
  | RecordMessage
  | StateMessage
  | DeleteMessage
  | (ResetMessage & { partition })
  | StreamStatus;
class StreamStatus {
  readonly stream: string;
  readonly status: 'STARTED' | 'FAILED' | 'ENDED';
  readonly partition: Partition | null;
  readonly error: unknown;
}
type ExtractionCoverage = {
  readonly description: string;
  readonly selection: { readonly [field: string]: JsonValue };
};
type FailureType = 'config' | 'system';
type ChangeSignal = {
  readonly gauge: Gauge; // Gauge and Check of @zukhruf/async
  readonly streams: readonly Stream[];
  readonly interval: number;
  readonly timeout: number;
};
type Upkeep = {
  readonly interval: number;
  readonly run: (signal: AbortSignal) => Promise<void>;
};

class Catalog {
  constructor(streams: Iterable<Stream>);
  readonly streams: readonly Stream[];
  get(name: string): Stream;
  select(streams: Iterable<Stream>): Catalog;
}
class Stream {
  constructor(declaration: {
    name: string;
    jsonSchema: StreamSchema;
    primaryKey?: readonly string[];
    supportedSyncModes: readonly SyncMode[];
    supportsFileTransfer?: true;
    sourceDefinedCursor?: true;
    defaultCursorField?: readonly [string];
    emitsDeletes?: true;
    partitionKey?: readonly string[];
    expiresBy?: string;
  });
  get file(): FileReference;
}
type Partition = Readonly<Record<string, KeyValue>>;
type PartitionState = {
  readonly partition: Partition;
  readonly state: unknown;
};
function readPartitions(stream: Stream, value: unknown): Partition[];

// Schemas and records
type StreamSchema = {
  readonly type: 'object';
  readonly description?: string;
  readonly properties?: Properties;
  readonly required?: readonly string[];
};
type Properties = Readonly<Record<string, FieldSchema>>;
// FieldSchema: a scalar, or an array of one scalar type or of objects, with its format.
// SchemaRecord<P>: the type of a record of the properties P.
type RecordDraft<P extends Properties> = { readonly [K in keyof P]: unknown };
function validateRecords<P extends Properties>(
  stream: {
    readonly name: string;
    readonly jsonSchema: { readonly properties?: P };
  },
  records: unknown,
  source: string,
): SchemaRecord<P>[];
// DeclaredFormat, declaredFormat(schema), Int64Format and LocalTimestampFormat: the string formats.
function isTimestamp(value: unknown): value is string;
function isCalendarDate(value: unknown): value is string;

// Snapshot streams
function diffSnapshot<Data extends Record<string, unknown>>(
  configuration: CopyConfiguration,
  records: AsyncIterable<Data> | Iterable<Data>,
  state: unknown,
  options: SnapshotDiffOptions & {
    readonly rereads?: (record: Data) => boolean;
  },
): AsyncGenerator<RecordMessage | DeleteMessage | StateMessage>;
function resumeGroupedSnapshot(
  configuration: CopyConfiguration,
  entries: SavedEntries,
): Promise<GroupedSnapshot>; // GroupedSnapshot of @zukhruf/snapshot-differential
function diffGroupedSnapshot<Data extends Record<string, unknown>>(
  configuration: CopyConfiguration,
  groups:
    | AsyncIterable<SnapshotGroup<Data> | KeptGroup | FailedGroup>
    | Iterable<SnapshotGroup<Data> | KeptGroup | FailedGroup>,
  snapshot: GroupedSnapshot,
  options: SnapshotDiffOptions,
): AsyncGenerator<RecordMessage | DeleteMessage | GroupedSnapshotState>;
// GroupedSnapshotState: a StateMessage with state null, the entries that
// changed, and snapshot, the new GroupedSnapshot.
type SnapshotDiffOptions = {
  readonly policy?: DeletionPolicy; // of @zukhruf/snapshot-differential
  readonly continues?: boolean;
  readonly signal: AbortSignal | undefined;
};
// KeptGroup: { key, kept: true }, and FailedGroup: { key, failed: true },
// of @zukhruf/snapshot-differential.

// The rows that a host holds
class IterableSource<
  const Schemas extends Readonly<Record<string, StreamSchema>>,
> extends Source {
  constructor(options: {
    readonly identity: string;
    readonly streams: {
      readonly [Name in keyof Schemas]: IterableStreamDeclaration<
        Schemas[Name]
      >;
    };
    readonly configErrors?: readonly (abstract new (
      ...args: never[]
    ) => Error)[];
  });
  readonly streams: { readonly [Name in keyof Schemas]: Stream };
  changed(stream: Stream): void;
}
type IterableStreamDeclaration<Schema> =
  SnapshotStreamDeclaration<Schema> | ChangesStreamDeclaration<Schema>;
// SnapshotStreamDeclaration<Schema>: description, jsonSchema, primaryKey, snapshot,
//   deletions?, rowVersion?, currentAsOf? and changeSignal?.
// ChangesStreamDeclaration<Schema>: description, jsonSchema, primaryKey, changes,
//   cursorField, ordered?, currentAsOf? and changeSignal?.
// IterableRow<Schema>: a row of the schema, with the required fields, and the others optional.
type IterableReadContext = { readonly signal: AbortSignal };
type IterableVersion = string | number;
type IterableChangesContext<Version extends IterableVersion = IterableVersion> =
  IterableReadContext & {
    readonly since: Version | null;
  };
type IterableTombstone<Version extends IterableVersion = IterableVersion> = {
  readonly deleted: Readonly<Record<string, KeyValue>>;
  readonly version: Version;
};
type IterableChangeSignal = {
  readonly gauge: (clock: PipelineClock) => Gauge;
  readonly interval: number;
  readonly timeout: number;
};

// Destinations
abstract class Destination<Target extends DestinationTarget> {
  abstract readonly supportedDestinationSyncModes: readonly DestinationSyncMode[];
  abstract location(target: Target): string;
  validate(configuration: CopyConfiguration, target: Target): void;
  protected validateConfiguration(
    configuration: CopyConfiguration,
    target: Target,
  ): void;
  abstract createWriter(
    configuration: CopyConfiguration,
    target: Target,
  ): Writer;
  abstract load(options: {
    clock: PipelineClock;
    connection: string;
  }): Promise<Load<Target>>;
  abstract failureType(error: unknown): FailureType;
  clear(
    configuration: CopyConfiguration,
    target: Target,
    clearing: Clearing,
    committed?: (values: FieldValues) => Promise<void>,
  ): Promise<void>;
}
abstract class Target {
  constructor(fileReads?: readonly FileRead[]);
  readonly fileReads: readonly FileRead[];
}
type Load<Target> = AsyncDisposable & {
  prepare(
    configuration: CopyConfiguration,
    target: Target,
    binding: { readonly writer: string; readonly reloading: boolean },
  ): Promise<Stage>;
};
type Stage = AsyncDisposable & {
  readonly fresh: boolean;
  readonly reloading: boolean;
  complete(): Promise<void>;
  values: FieldValues;
  apply(operation: WriteOperation): Promise<void>;
  commit(): Promise<void>;
  discard(): Promise<void>;
};
type WriteOperation =
  | { readonly type: 'RECORD'; readonly data: unknown }
  | {
      readonly type: 'DELETE';
      readonly key: Readonly<Record<string, KeyValue>>;
      readonly cursor?: string | number;
    }
  | { readonly type: 'RESET'; readonly partition: Partition | null };
type DeleteOperation = Extract<WriteOperation, { readonly type: 'DELETE' }>;
type FieldValues = (field: string) => AsyncIterable<unknown>;
type Clearing = {
  readonly writer: string;
  readonly clock: PipelineClock;
  readonly connection: string;
};
abstract class Writer {
  constructor(stream: Stream);
  readonly stream: Stream;
  abstract clear(
    clearing: Clearing,
    committed?: (values: FieldValues) => Promise<void>,
  ): Promise<void>;
}
class TargetOwnedError extends TypeError {}
class StreamChangeError extends TypeError {}

// Checkpoints and the sync history
abstract class CheckpointStore {
  run<T>(
    bindings: ReadonlyMap<string, CheckpointBinding>,
    work: (run: CheckpointRun) => Promise<T>,
  ): Promise<T>;
  reset(id: string): Promise<void>;
  clear(id: string, drop: () => Promise<void>): Promise<void>;
  abstract failureType(error: unknown): FailureType;
  protected abstract session<T>(
    ids: readonly string[],
    work: (session: CheckpointSession) => Promise<T>,
  ): Promise<T>;
}
type CheckpointBinding = { readonly copy: object; readonly shape: object };
type CheckpointRun = {
  state(id: string): Promise<unknown>;
  reloading(id: string): boolean;
  save(id: string, state: string, reloading: boolean): Promise<void>;
  reloaded(id: string): Promise<void>;
};
type CheckpointSession = {
  read(id: string): Promise<StoredCheckpoint | undefined>;
  state(id: string): Promise<string | undefined>;
  save(
    id: string,
    checkpoint: StoredCheckpoint & { readonly state: string },
  ): Promise<void>;
  reloaded(id: string): Promise<void>;
  remove(id: string): Promise<void>;
};
type StoredCheckpoint = {
  readonly binding: string;
  readonly reloading: boolean;
};

abstract class SyncHistory<Target extends DestinationTarget> {
  validate(connection: Connection<Target>): void;
  abstract install(
    connections: readonly Connection<Target>[],
    at: Date,
  ): Promise<void>;
  abstract begin(
    connection: Connection<Target>,
    copies: readonly DeclaredCopy<Target>[],
    at: Date,
  ): Promise<RecordedPass<Target>>;
  checked(
    connection: Connection<Target>,
    at: Date,
    current: (at: Date) => Promise<readonly StreamCheck[]>,
  ): Promise<void>;
  protected abstract recordChecks(
    connection: Connection<Target>,
    checks: readonly StreamCheck[],
  ): Promise<void>;
}
type DeclaredCopy<Target> = {
  readonly copy: Copy<Target>;
  readonly coverage: ExtractionCoverage;
};
type RecordedPass<Target> = AsyncDisposable & {
  finish(
    outcomes: readonly CopyOutcome<Target>[],
    upstream: ReadonlyMap<string, Date>,
    at: Date,
  ): Promise<void>;
  fail(error: unknown, failureType: FailureType, at: Date): Promise<void>;
};
type StreamCheck = { readonly stream: string; readonly at: Date };
type SyncStatus = 'succeeded' | 'partial' | 'failed' | 'cancelled';
function copyStatus(outcome: CopyOutcome<DestinationTarget>): SyncStatus;
function passStatus(
  outcomes: readonly CopyOutcome<DestinationTarget>[],
): SyncStatus;
function passFailureType(
  outcomes: readonly CopyOutcome<DestinationTarget>[],
): FailureType | null;
function passError(
  outcomes: readonly CopyOutcome<DestinationTarget>[],
): string | null;
function recordedFailure(failure: LoadFailure): {
  partition;
  error: string;
  failure_type: FailureType;
  stacktrace: string;
};
function errorMessage(error: unknown): string;
// syncHistoryRelations: the descriptions of sync_attempts, extraction_coverage,
//   sync_status, stream_status and derived_status.
type PassState = SyncStatus | 'running';
// PassStatus: state, startedAt, completedAt, lastSucceededAt, currentAsOf, error and failureType.
// StreamPassStatus: stream, state, lastSucceededAt, currentAsOf and error.
// SyncStatusRow and StreamStatusRow: a row of sync_status and of stream_status.
function combinedPass(
  passes: readonly [PassStatus, ...PassStatus[]],
): PassStatus;
function recordedPassStatus(row: SyncStatusRow): PassStatus;
function recordedStreamStatus(row: StreamStatusRow): StreamPassStatus;

// Files
class FileReference {
  readonly stream: Stream;
  store(storage: FileStorage): FileReference;
  accepting(parser: DocumentParser): FileReference;
}
class FileRead {
  constructor(name: string, file: FileReference, parser?: DocumentParser);
  accepts(fileName: string): boolean;
}
class FileContent {
  constructor(path: string);
  readonly path: string;
  chunks(size: number): AsyncGenerator<Uint8Array>;
}
function fileExtension(name: string): string;
abstract class FileStorage {
  abstract readonly identity: string;
  abstract readonly reference: string;
  abstract save(scope: string, content: FileContent): Promise<string>;
  abstract flush(scope: string): Promise<void>;
  abstract retain(
    scope: string,
    references: ReadonlySet<string>,
  ): Promise<void>;
  abstract open(
    ref: string,
    signal?: AbortSignal,
  ): Promise<{ readonly path: string } & AsyncDisposable>;
  abstract head(
    ref: string,
    length: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
  abstract failureType(error: unknown): FailureType;
}
class StoredFileMissingError extends Error {}
class LocalFiles extends FileStorage {
  constructor(options: { directory: string });
  readonly directory: string;
}
abstract class DatabaseFiles<
  Connection extends AsyncDisposable | Disposable,
> extends FileStorage {
  constructor(table: string);
  protected abstract connect(): Promise<Connection>; // and write, rename, remove, names and read
}
abstract class DocumentParser {
  constructor(identity: string);
  readonly identity: string;
  abstract parse(path: string, signal?: AbortSignal): Promise<string | null>;
  accepts(fileName: string): boolean;
  identityFor(file: DocumentFile): Promise<string | null>;
}
type DocumentFile = {
  readonly name: string;
  head(length: number): Promise<Uint8Array>;
};

// Derived datasets
abstract class DerivedDataset<Target extends DestinationTarget> {
  abstract readonly name: string;
  validate(connections: readonly Connection<Target>[]): void;
  abstract refresh(options: {
    readonly connections: readonly Connection<Target>[];
    readonly clock: PipelineClock;
    readonly earlier: readonly DerivedDataset<Target>[];
    readonly signal?: AbortSignal;
    readonly trigger: RefreshTrigger;
  }): Promise<void>;
}
abstract class CompositeDataset<Target extends DestinationTarget> {
  abstract readonly name: string;
  abstract readonly members: readonly [
    DerivedDataset<Target>,
    ...DerivedDataset<Target>[],
  ];
  validate(connections: readonly Connection<Target>[]): void;
}
type DeclaredDataset<Target> =
  DerivedDataset<Target> | CompositeDataset<Target>;
type RefreshTrigger =
  | { readonly kind: 'commit'; readonly tried: Set<string> }
  | { readonly kind: 'pass'; readonly tried: ReadonlySet<string> };
type DatasetFailure = {
  readonly kind: 'refresh';
  readonly dataset: string;
  readonly error: unknown;
};
class DerivedDatasetError extends Error {
  readonly dataset: string;
}
class DerivedDatasetsError extends AggregateError {
  readonly errors: DerivedDatasetError[];
}

// Rules
abstract class Rule<Input, Columns extends RuleColumns> {
  abstract readonly key: {
    readonly name: string;
    readonly description: string;
  };
  abstract readonly output: Columns;
  abstract readonly batch: number;
  abstract readonly concurrency: number;
  abstract read(
    row: LoadedRow,
  ): { readonly key: string; readonly input: Input } | null;
  abstract identity(input: Input): Promise<string | null>;
  abstract compute(
    inputs: readonly Input[],
    signal?: AbortSignal,
  ): Promise<readonly RuleResult<RuleValues<Columns>>[]>;
}
abstract class TableRule<
  Input,
  Columns extends RuleColumns,
  Place extends RuleColumns,
> {
  // key, output, batch, concurrency, read and identity as in Rule
  abstract readonly place: Place;
  abstract compute(
    inputs: readonly Input[],
    signal?: AbortSignal,
  ): Promise<
    readonly TableRuleResult<RuleValues<Columns> & RuleValues<Place>>[]
  >;
}
type RuleColumn =
  | { readonly type: 'text'; readonly description: string }
  | { readonly type: 'blob'; readonly description: string }
  | {
      readonly type: 'vector';
      readonly dimensions: number;
      readonly description: string;
    }
  | { readonly type: 'integer'; readonly description: string };
type RuleColumns = Readonly<Record<string, RuleColumn>>;
// RuleValues<Columns>: for each column, an optional string, Uint8Array, Vector or number, by its kind.
type RuleResult<Output> =
  | { readonly value: Output }
  | { readonly empty: true }
  | { readonly error: string }
  | { readonly gone: true };
type TableRuleResult<Part> =
  | { readonly parts: readonly [Part, ...Part[]] }
  | { readonly empty: true }
  | { readonly error: string }
  | { readonly gone: true };
type LoadedRow = Readonly<Record<string, unknown>>;
function rowText(row: LoadedRow, fields: readonly string[]): string | null;
class DocumentText extends Rule<string, { content }> {
  constructor(options: {
    parser: () => DocumentParser;
    files: FileStorage;
    column: string;
  });
}

// The work of a destination. See "Positions of a destination", "Derived datasets of a
// destination" and "Names".
type Position = { readonly epoch: string; readonly number: number };
type NumberedStore = { readonly engine: string; readonly noun: string };
// Numbering: epoch, minValid, expiredBy, settled and ends.
// numbering, parsePosition, positionsAfter, readingExpiry, readingNumber and staleness.
// refreshComputed, refreshView, computedColumns, partsView, reservedColumns and
//   refuseTakenColumns, with OutputRow, TableOutputRow, PartRow, PreparedOutputs and StoredOutput.
abstract class DerivedStatus {
  constructor(clock: PipelineClock);
  waiting(): Promise<void>;
  refreshing(counts: DerivedCounts): Promise<void>;
  current(counts?: DerivedCounts): Promise<void>;
  failed(error: string): Promise<void>;
  protected abstract write(
    values: Readonly<Record<string, string | number | null>>,
  ): Promise<void>;
}
type DerivedCounts = {
  readonly inputs: number;
  readonly computed: number;
  readonly empty: number;
  readonly failed: number;
  readonly pending: number;
};
type DatasetIndex<Ordinary extends string, Build extends object> =
  | {
      readonly type: Ordinary;
      readonly columns: readonly [string, ...string[]];
    }
  | ({
      readonly type: 'vector';
      readonly column: string;
      readonly metric: VectorMetric;
    } & Build);
type VectorMetric = 'cosine' | 'euclidean' | 'dot';
type ReloadMode = 'load' | 'create' | 'evolve' | 'reload' | 'continue';
type StoredFit = 'missing' | 'stale' | 'fits';
function reloadMode(options: {
  readonly reloading: boolean;
  readonly destinationSyncMode: DestinationSyncMode;
  readonly target: StoredFit;
  readonly hidden: StoredFit;
}): ReloadMode;
type Reloads = WholeStream | SomePartitions;
class WholeStream {}
class SomePartitions {
  constructor(partitions: readonly Partition[]);
  readonly partitions: readonly Partition[];
  with(partition: Partition): SomePartitions;
}
const wholeStream: WholeStream;
abstract class Identifiers {
  protected abstract readonly maxBytes: number;
  protected abstract readonly ownColumns: readonly string[];
  abstract key(name: string): string;
  columns<Column extends { readonly field: string }>(
    columns: readonly Column[],
  ): readonly (readonly [Column, string])[];
  relation(name: string): string;
  reader(name: string): string;
}
type ReaderRelation = {
  readonly name: string;
  readonly description: string;
  readonly columns: Readonly<Record<string, string>>;
};
const readerCatalog: ReaderRelation;
// targetFileReads, schemaColumns, requireDescribed, deduplicationColumns and describeTarget,
//   with DeduplicationColumns, DescribedColumn and TargetDescription.
```

## Recipes

One use case each, with a full program that you can run:

- [Write a rule and a table rule, and compute a dataset with them](./docs/recipes/write-a-rule-for-a-computed-dataset.md)
- [Write a kind of derived dataset whose output is not one row for each key](./docs/recipes/write-a-kind-of-derived-dataset.md)
- [Write a composite dataset whose members refresh in order](./docs/recipes/write-a-composite-dataset.md)
- [Write a source for an upstream with no change feed](./docs/recipes/write-a-source-for-an-upstream-with-no-change-feed.md)

## Decisions

- [ADR 0001](./docs/adr/0001-derived-data-is-declared-on-the-pipeline.md): derived data is declared on the pipeline.
- [ADR 0002](./docs/adr/0002-a-run-refreshes-its-derived-data-also-when-copies-failed.md): a run refreshes its derived data also when copies failed.
- [ADR 0003](./docs/adr/0003-a-watch-refreshes-in-the-background-one-refresh-at-a-time.md): a watch refreshes in the background, one refresh at a time. [ADR 0031](./docs/adr/0031-a-dataset-failure-fails-only-its-dataset-and-a-watch-gives-it-beside-its-passes.md) supersedes it in part.
- [ADR 0004](./docs/adr/0004-a-rule-failure-stays-on-its-output.md): a rule failure stays on its output. Superseded in part on 2026-11-23 (datahub #5453) by [ADR 0031](./docs/adr/0031-a-dataset-failure-fails-only-its-dataset-and-a-watch-gives-it-beside-its-passes.md).
- [ADR 0005](./docs/adr/0005-an-output-is-made-again-when-its-rule-identity-changes.md): an output is made again when its rule identity changes.
- [ADR 0006](./docs/adr/0006-a-stream-whose-fields-change-keeps-its-rows-and-its-checkpoint.md): a stream whose fields change keeps its rows and its checkpoint.
- [ADR 0007](./docs/adr/0007-a-stream-that-starts-over-reloads-into-a-hidden-target.md): a stream that starts over reloads into a hidden target. Superseded in part on 2026-11-22 (#5170).
- [ADR 0008](./docs/adr/0008-a-target-has-one-writer.md): a target has one writer.
- [ADR 0009](./docs/adr/0009-a-target-is-named-by-its-address-inside-the-destination.md): a target is named by its address inside the destination.
- [ADR 0010](./docs/adr/0010-a-watch-keeps-watching-after-an-incomplete-pass.md): a watch keeps watching after an incomplete pass.
- [ADR 0011](./docs/adr/0011-a-watch-loads-a-stream-again-after-a-system-failure.md): a watch loads a stream again after a system failure.
- [ADR 0012](./docs/adr/0012-every-failure-says-whose-it-is-to-fix.md): every failure says whose it is to fix.
- [ADR 0013](./docs/adr/0013-the-pipeline-installs-its-sync-history-before-each-run-and-watch.md): the pipeline installs its sync history before each run and watch.
- [ADR 0014](./docs/adr/0014-a-source-says-how-current-each-stream-s-upstream-is.md): a source says how current the upstream of each stream is.
- [ADR 0015](./docs/adr/0015-a-stored-file-s-ref-is-relative-to-its-folder.md): a stored file's ref is relative to its folder. [ADR 0030](./docs/adr/0030-a-rule-reads-a-stored-file-through-its-storage.md) supersedes it in part.
- [ADR 0016](./docs/adr/0016-a-watch-watches-again-after-its-watcher-fails-for-a-system-reason.md): a watch watches again after its watcher fails for a system reason. [ADR 0020](./docs/adr/0020-a-source-gives-its-change-signals-and-a-failed-signal-fails-only-its-streams.md) supersedes it in part.
- [ADR 0017](./docs/adr/0017-each-commit-asks-for-a-refresh.md): each commit asks for a refresh. Superseded in part on 2026-11-23 (datahub #5453) by [ADR 0031](./docs/adr/0031-a-dataset-failure-fails-only-its-dataset-and-a-watch-gives-it-beside-its-passes.md).
- [ADR 0018](./docs/adr/0018-the-streams-of-a-read-are-one-task-group.md): the streams of a read are one task group.
- [ADR 0019](./docs/adr/0019-a-pipeline-waits-and-reads-the-time-on-the-clock-that-its-caller-gives.md): a pipeline waits and reads the time on the clock that its caller gives.
- [ADR 0020](./docs/adr/0020-a-source-gives-its-change-signals-and-a-failed-signal-fails-only-its-streams.md): a source gives its change signals, and a failed signal fails only its streams.
- [ADR 0021](./docs/adr/0021-a-source-keeps-its-upstream-producing-through-an-upkeep.md): a source keeps its upstream producing through an upkeep.
- [ADR 0022](./docs/adr/0022-a-stream-s-key-is-an-identity-its-upstream-enforces.md): a stream's key is an identity that its upstream enforces.
- [ADR 0023](./docs/adr/0023-a-clear-forgets-the-rows-it-removes.md): a clear forgets the rows that it removes.
- [ADR 0024](./docs/adr/0024-a-reset-of-a-partition-reloads-it-into-a-hidden-target.md): a reset of a partition reloads it into a hidden target.
- [ADR 0025](./docs/adr/0025-each-derived-dataset-tells-readers-how-current-it-is.md): each derived dataset tells readers how current it is.
- [ADR 0026](./docs/adr/0026-a-rule-can-give-many-parts-for-one-input.md): a rule can give many parts for one input.
- [ADR 0027](./docs/adr/0027-a-dataset-reads-the-parts-of-a-computed-dataset-through-a-view.md): a dataset reads the parts of a computed dataset through a view.
- [ADR 0028](./docs/adr/0028-a-host-names-each-relation-that-readers-query-once.md): a host names each relation that readers query once.
- [ADR 0029](./docs/adr/0029-the-side-that-raised-a-failure-names-its-type.md): the side that raised a failure names its type.
- [ADR 0030](./docs/adr/0030-a-rule-reads-a-stored-file-through-its-storage.md): a rule reads a stored file through its storage.
- [ADR 0031](./docs/adr/0031-a-dataset-failure-fails-only-its-dataset-and-a-watch-gives-it-beside-its-passes.md): a dataset failure fails only its dataset, and a watch gives it beside its passes.
- [ADR 0032](./docs/adr/0032-a-deletion-older-than-the-stored-row-deletes-nothing.md): a deletion older than the stored row deletes nothing.
- [ADR 0033](./docs/adr/0033-a-host-loads-the-rows-it-holds-through-an-iterable-source.md): a host loads the rows that it holds through an `IterableSource`.
- [ADR 0034](./docs/adr/0034-a-composite-dataset-refreshes-its-members-in-order-as-one-dataset.md): a composite dataset refreshes its members in order as one dataset.
- [ADR 0035](./docs/adr/0035-a-checkpoint-keeps-keyed-entries-beside-its-state.md): a checkpoint keeps keyed entries beside its state.
- [ADR 0036](./docs/adr/0036-a-grouped-snapshot-is-kept-in-three-spaces-of-keyed-entries.md): a grouped snapshot is kept in three spaces of keyed entries.

## Development

Run the commands from the workspace root.

```sh
npx nx run elt:test        # builds, then runs src/index.test.ts
npx nx run elt:typecheck   # formats, lints, then type checks
npx nx run elt:build       # compiles src/ to dist/
```

The files of the pipeline:

```
src/core/
  pipeline.ts           Pipeline: run, watch, retries, and the refreshes at each commit
  replication.ts        one pass: checkpoints, the load and its stages
  connection.ts         Connection
  copy.ts               Copy, its outcome and its progress
  copy-configuration.ts the modes, keys, cursor and dedup policy of a copy
  source.ts             Source: read, watch, coverage, currentAsOf, failureType
  stream.ts             Stream: the metadata of one stream
  destination.ts        Destination and Load: the port of each destination
  reload-mode.ts        reloadMode: load, make, evolve or reload a target
  reloads.ts            Reloads: what an open reload reloads, the whole stream or some partitions
  snapshot.ts           diffSnapshot and diffGroupedSnapshot
  iterable-source.ts    IterableSource: the rows that a host holds, with no Source subclass
  partition.ts          the checkpoint of a partitioned stream
  identifiers.ts        Identifiers: the naming rule, and the name of a reader view
  target.ts             Target, and targetFileReads: the checks of the columns a host declares
  schema-columns.ts     schemaColumns and requireDescribed: the columns of a stream's JSON Schema
  deduplication-columns.ts  deduplicationColumns: the key, cursor and guard columns of a deduplicating copy
  file-read.ts          FileRead and FileReference: the file declarations of a copy
  file-transfer.ts      the save, flush and retain of stored files around each commit
  file-storage.ts       FileStorage: the port of each file storage
  document-parser.ts    DocumentParser: the port of each parser
  position.ts           Position, Numbering and the rules of positions that each destination applies
  formats/              the string formats
src/storage/
  local-files.ts        LocalFiles
src/state/
  checkpoint-store.ts   CheckpointStore: the checkpoint protocol
  sync-history.ts       SyncHistory and its helpers
  sync-history-relations.ts  the descriptions of the history views
  pass-status.ts        PassStatus, combinedPass and the rows that give them: the latest pass that a history records
```

The files of derived data:

```
src/core/
  derived-dataset.ts    DerivedDataset: the port of each kind
  composite-dataset.ts  CompositeDataset: many derived datasets of one declaration
  derived-refreshes.ts  the refreshes of a watch, one at a time
  rule.ts               Rule, RuleResult, LoadedRow, RuleColumn, rowText
  computed-refresh.ts   refreshComputed: what is due, and the pool of rule calls
  view-refresh.ts       refreshView: when a view waits
  derived-status.ts     DerivedStatus: the states of derived_status
  document-text.ts      DocumentText: the text of each stored file
```
