# @workspace/elt

Copies the data of apps and services into stores that SQL can read. A source reads an upstream, for example the Mail store of a Mac. A destination keeps each stream as a table, for example in one SQLite file. The pipeline starts the copies, and it keeps derived datasets in step with what they load. A derived dataset is data that the pipeline can always make again from the loaded data, for example the text of each stored file, or a view that counts rows. Kleppmann calls it derived data, and Estuary calls it a derivation.

This README tells how a pipeline copies, resumes, watches, fails and records its passes, and how it keeps derived datasets. The SQLite destination is in [elt-sqlite](../destinations/sqlite/README.md), and the Postgres destination is in [elt-postgresql](../destinations/postgresql/README.md).

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Copy a stream

This example copies two streams of Apple Notes into one SQLite file. The pipeline types come from `elt`. The SQLite destination, its checkpoint store and its sync history come from `elt-sqlite`. Each Apple source has its own package, `@workspace/source-apple-<name>` in `packages/sources/apple`. The later examples use `notes`, `sqlite`, `checkpoints` and `history` from this example.

```ts
import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';
import { AppleNotesSource } from '@workspace/source-apple-notes/apple-notes-source';

const notes = new AppleNotesSource();
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
const pipeline = new Pipeline({ history, connections: [connection] });

const results = await pipeline.run(); // [{ copy, count, deleted }, ...] in declaration order
```

- A `Connection` is the connection of Airbyte: the copies of one source into one destination, with the checkpoints that resume them. Readers of the sync history see its `name`.
- A `Pipeline` is the orchestrator of one or more connections. See [Run and failures](#run-and-failures).
- The copy of `accounts` declares its columns. The copy of `notes` infers its columns from the stream, and it deduplicates on the `id` key of the stream.
- Apple Notes gives its streams as properties: `accounts`, `folders`, `notes`, `inlineAttachments` and `attachments`. `discover()` gives the same frozen streams to code that lists streams.
- A declaration does not read Notes, and `discover()` does not read Notes. Neither opens a store.

## Sync modes

`syncMode` selects how the source extracts. `destinationSyncMode` selects how the destination loads. The SQLite and Postgres destinations have these five pairs:

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
- The two destinations apply the policy. SQLite applies it as the guard of the upsert. Postgres applies it when it merges each staged commit into its table.
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

A stream that declares `emitsDeletes` can send `DELETE` messages in an incremental read. Each `DELETE` holds the fields of the `primaryKey` of the stream, and no other field. Such a stream always declares its key. Its incremental copies must use `append_dedup`, which deduplicates on that key, so the destination can find the row.

| Destination                         | What a `DELETE` does                                       |
| ----------------------------------- | ---------------------------------------------------------- |
| SQLite and Postgres, `append_dedup` | Deletes the row with that key in the commit of the stream. |

- Records and deletions apply in the order that the source emits them.
- A `DELETE` of a key that is not there does nothing. Thus a pass can run again safely.
- The copy refuses a deletion when the stream does not declare `emitsDeletes`, when the key is not correct, or when the load does not deduplicate.
- The results count the accepted deletions as `deleted`, apart from `count`.

### Resets

A stream that emits deletions can also send `{ type: 'RESET', stream }`. It sends it when the upstream cannot tell what changed since the checkpoint, for example when its change history expired. The stream then starts again in a hidden target:

- What the stream emits after the reset commits into the hidden target. Its checkpoints also go there.
- Readers see the earlier rows until the stream ends with no failure. Then the hidden target takes the place of the target.
- A reload that fails stays hidden. The engine saves with each checkpoint whether a reload is open, so the next run resumes the reload from its last checkpoint.
- The destination drops a hidden target that no checkpoint continues. A new reset starts the reload again.
- For a partitioned stream, a reset applies only to the partition that the source reads. The next commit drops the rows of that partition, and keeps only what the source emits after the reset.
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
- **Stored nullability.** A stored table is `NOT NULL` only on `loaded_at` and on the explicit primary key columns, because a field that is added later has no value on earlier rows. The Postgres destination of Airbyte also adds columns as nullable, because it does not "know what constitutes a reasonable default value for preexisting records" ([source](https://github.com/airbytehq/airbyte/blob/f847ad015360face1837f5a77c64325f104157f0/airbyte-integrations/connectors/destination-postgres/src/main/kotlin/io/airbyte/integrations/destination/postgres/sql/PostgresDirectLoadSqlGenerator.kt#L608-L615)). The destination still checks each record that it writes for its required fields, and a deduplicating load refuses a NULL key or cursor.

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
- A clear refuses a target that a different writer owns.
- A target that a person dropped by hand also releases its writer. Its copy loads it again from no checkpoint, because a resume would load only what changed since the checkpoint.

Several properties or accounts share tables through one [partitioned stream](#partitioned-streams), which is one writer.

## Keys, cursors and schemas

Three different things control identity:

- `Stream.primaryKey` is the identity of the source, as `sourceDefinedCursor` is its cursor (Airbyte calls the key `source_defined_primary_key`). A deduplicating copy of a stream that declares a key uses that key. The key alone does not make a SQL unique constraint, and it does not select deduplication.
- The `Copy` option `primaryKey: ['id']` or `['tenantId', 'id']` selects the identity only for a stream that declares no key. The constructor of `Copy` refuses `primaryKey` for a stream with a key: `Stream <name> defines its own primary key; omit primaryKey`.
- `.primaryKey()` on a SQLite column is a physical constraint. An append that conflicts with it fails and rolls back that copy. It never becomes an update.

Rules for keys and cursors:

- The two deduplication modes need a key: the key of the stream, or the `primaryKey` of the copy for a stream with no key. Otherwise the copy fails with `Stream <name> declares no primary key; select primaryKey`.
- A load that does not deduplicate refuses `primaryKey` and `dedupPolicy`.
- `cursor_newer` needs `cursorField`. `replace` works with no cursor.
- A stream with `sourceDefinedCursor` has no cursor field. Its copies do not give `cursorField`. Its deduplicating loads use `replace`, and they refuse `cursor_newer`.
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

Stream properties are scalars, or arrays of one scalar type:

- An array field declares `type: 'array'` (or `['array', 'null']`) and an `items` schema. The `items` schema has the type of the element, and its `enum`, range, `minLength` and date `format`.
- `validateRecords` checks each element. It refuses constraints on the array itself.
- Arrays hold lists of values, such as keywords or counts for each day. A collection whose members have their own fields is a different stream of rows.
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
- The names that the destination writes come first. `loaded_at` is one in the two destinations. Postgres also has the system column names `xmin`, `xmax`, `cmin`, `cmax`, `ctid` and `tableoid`. Thus a field `loaded_at` becomes `loaded_at_1`.
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
- `extract` emits records `{ stream, data }`, deletions `{ type: 'DELETE', stream, key }`, [resets](#resets) `{ type: 'RESET', stream }` and checkpoints `{ type: 'STATE', stream, state }`.
- Their text must be well-formed Unicode. A string or a field name with a lone surrogate fails its stream, because SQLite would store U+FFFD and Postgres refuses it.
- The state belongs to the source. It must go into JSON and come back with no change. Destinations do not read it.

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
- A store gives a session that holds the lock of each copy for the full pass. A `save` of the session is durable when it resolves.
- With each checkpoint, the store saves whether a reload is open ([resets](#resets)).

| Store                                      | Package                                                            |
| ------------------------------------------ | ------------------------------------------------------------------ |
| `SQLiteCheckpointStore({ path })`          | [elt-sqlite](../destinations/sqlite/README.md#checkpoints)         |
| `PostgresCheckpointStore({ url, schema })` | [elt-postgresql](../destinations/postgresql/README.md#checkpoints) |

## Snapshot streams

A source with no change feed can still load incrementally with `diffSnapshot(configuration, records, state, { policy, signal })`. This is a [snapshot differential](https://github.com/JanuaryLabs/zukhruf/tree/main/packages/snapshot-differential#readme) (Labio and Garcia-Molina, VLDB 1996).

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
- **Stop:** a scan that finds no change yields no message until its state. A scan that never waits for I/O would make all other tasks of the process wait until it ends, also the stop of the host. Thus the diff gives the event loop a turn every 10 ms and checks `signal` at each record or group. A cancelled run stops in moments. It never ends as a complete scan, which could delete the keys that it did not read. `signal` is required, so no source can leave it out.
- **Reset:** a reset of the checkpoint makes the next run load all records again, but it forgets which rows exist. Rows that the upstream deleted in that time stay. Reset and clear the target together, or run a full refresh with `overwrite`.
- **Full refresh:** the source calls `diffSnapshot` in the same way in the two sync modes. In a full refresh, the diff checks the declaration of the stream as an incremental copy does. Then it emits each record of the scan, one at a time, as the scan yields it, and it saves no state. The copy replaces its target, so it compares nothing. The CDK of Airbyte does the same: `Stream.read` selects its checkpoint reader by the sync mode, so the mode stays a concern of the framework and never gets to the code of the stream.

### Grouped snapshots

Some records come from inputs that the source can fingerprint and not read, such as files whose stat identifies their content. For them, `diffGroupedSnapshot(configuration, groups, state, { policy, signal })` does not read the unchanged inputs.

- Each group is `{ key, fingerprint, records() }`: one input, a fingerprint of it, and a function that reads its records.
- In an incremental copy, a group whose fingerprint is equal to the saved fingerprint of its key keeps its saved rows. The diff does not call its `records()`. The diff reads and compares each other group, and each group whose fingerprint is `null`, record by record.
- A source that knows that a group did not change can give a kept group, `{ key, kept: true }`, with no fingerprint. The group keeps its saved rows. A kept group that the snapshot does not have fails the diff. A full refresh reads each group, so it refuses a kept group.
- The state is `{ groups: { <group key>: { fingerprint, snapshot } } }`, with `snapshot` as above. It also has `unknown`, the keys that the policy judged unknown, when there is one.
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

The partitions are declared with no I/O. The `partitionKey` fields must be different scalar members of the primary key that are not null. The list must not be empty, and it must have no repeated partition.

## Read context

A pass is one read of one connection: one `Source.read(catalog, states, signal)` over each stream that the connection selected, as `read(config, catalog, state)` of Airbyte. `Pipeline.run()` makes one pass for each connection. The source opens one context for the full read, so related streams tell of the same moment of the upstream. Separate reads would let a stream that joins refer to a row that its parent stream never saw.

```ts
class ChatSource extends Source<ChatDatabase> {
  protected override open(streams, signal) {
    return ChatDatabase.open(this.path); // AsyncDisposable, disposed when the read ends
  }

  protected override async *extract(configuration, state, partition, database) {
    // database is the read's context
  }
}
```

- **Contract:** each source implements `open(streams, signal)`. It gets the streams that the read covers and the signal of the run. An `open` that waits for its upstream gives the signal on, so a cancelled run stops it, as Calendar and Reminders stop their EventKit helper.
  - An upstream with a read transaction holds it (Messages; Notes; Contacts, one time for each account store).
  - An upstream without one reads each selected stream first, in one window with no change, and gives the streams from that snapshot (Calendar and Reminders; see [EventKit consistency](../sdks/apple/eventkit/README.md#consistent-reads)).
  - A source whose streams do not have to agree returns an empty `AsyncDisposableStack` (Search Console).
- **Stream status:** each stream reads as `STARTED`, then its messages, then `ENDED`. A partition or stream that failed adds `FAILED` with its error. Only `Source.read` makes a `StreamStatus`. A `StreamStatus` that `extract` yields fails its stream with a `TypeError`. So does a message that names a stream other than the stream that the source extracts. Thus a stream can never write into the target of a different stream.
- **Interleaving:** `protected concurrency` (1 when not set) sets how many streams read at the same time. Their messages interleave. The read asks a stream for its next message only after the consumer took its last message, so the file of a record stays valid until the consumer moves on. A source that sets a higher value reads its context from several extracts together. The partitions of one stream always read one after the other.
- **Lifetime:** the context opens when the read starts and closes when it ends, also when it fails. A watch reads one time in each pass and holds nothing between passes, because a long read can block the maintenance of the upstream.
- **Failures:** a context that cannot open (a refused permission, a missing store) fails each copy of that pass. `PipelineError.cause` is the error. The passes of other connections continue.
- **One copy for each stream:** a connection copies each stream one time (`Connection <name> copies each stream once`), as the configured catalog of Airbyte lists each stream one time. To load one stream into two targets, use two connections.

## Stored files and document parsing

A stream that supports file transfer, such as `attachments` of Notes, gives a file with each record. A copy declares in its columns what it takes from the file: the parsed text, a stored file, or the bytes in the database.

```ts
import { Connection, Copy, LocalFiles, Pipeline } from '@workspace/elt';
import { SQLiteSyncHistory } from '@workspace/elt-sqlite';
import { MacOSDocumentParser } from '@workspace/source-apple-macos/macos-document-parser';

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
- `.from(file)` selects the original file. `.parse(parser)` asks for its text.
- `.store(files)` on the file reference selects a file storage, apart from the connection and the destination. Two fields can use different storages, and copies can share one storage and still own their files apart.
- A stored file and parsed text must be separate fields. `.parse()` on a stored file field is refused.
- `c.blob('bytes').from(file)` keeps the original bytes in the database. See [elt-sqlite](../destinations/sqlite/README.md#file-bytes-in-the-database) and [elt-postgresql](../destinations/postgresql/README.md#file-bytes-in-the-database). A plain `c.blob('bytes')` reads the existing `bytes` field of a record into an inline value.
- Original bytes need a `BLOB` column. Parsed text and stored file references need `TEXT`. `.notNull()` and `.primaryKey()` apply to these fields.
- Types that do not agree, the file reference of a different stream, and fields with the name of a field of the source metadata or of `loaded_at` fail before the copy extracts.
- A bare table still infers the metadata schema of the source. To keep all metadata beside the file columns, spread `SQLiteColumns.fromSchema(notes.attachments.jsonSchema)` into the columns.
- All declarations are immutable and do no I/O. A storage that you make and a field that you declare do no I/O either. The copy never writes the source schema again to describe the fields of the destination.
- One copy can take several named forms of one file. The copy reads each record one time. Fields with the same parser instance share one parse, and fields of the original bytes share one read. Separate copies keep separate extraction and checkpoint progress.
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

// Original bytes only; no parser runs.
new Copy(
  notes.attachments,
  sqlite.table('originals', (c) => [
    c.text('id'),
    c.blob('bytes').from(notes.attachments.file),
  ]),
);
```

### How a source gives files

- `Source.read()` is the shared template method. A source implements `extract(configuration, state, partition, context, signal)`, and yields metadata, an optional file path, and state.
- `Source.read()` resolves `configuration.fileReads` into parsed text or a `FileContent` before it yields the record. A `FileContent` is valid until the consumer takes the next record.
- A path must stay readable until the consumer moves past its record. It can be a staged copy that the source removes after, or the original file when a copy would cost too much. Notes and Messages give their original attachment files.
- The replication refuses a record that still holds a source file path (`Destinations cannot receive source file paths`).
- A source names a staged copy with `fileExtension` from `elt`: the extension of the file when it is 1 to 16 letters or digits, else none. The original file name stays in the source metadata.

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

| Member                      | Gives                                                                                                                |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `identity`                  | A stable identity. It is part of the checkpoint binding of the copy.                                                 |
| `reference`                 | A sentence that tells readers what a ref is. Postgres writes it as the comment of the ref column.                    |
| `save(scope, content)`      | Saves a `FileContent`, and returns a complete, immutable ref. A save again of the same content returns the same ref. |
| `flush(scope)`              | Makes the completed saves durable before their rows commit. It is safe to repeat, also for a scope with no saves.    |
| `retain(scope, references)` | Removes only the objects of this scope that no committed ref names.                                                  |

- The transfer reads refs as text that it does not interpret. Thus an S3 storage can return its own form of ref, with no change to the destinations.
- Only `LocalFiles` exists now. Its reconcile scans the kept refs and the folder of the scope at each commit. It keeps no separate index of objects.

### Write a document parser

Extend `DocumentParser` with `parse(path, signal?): Promise<string | null>`.

- Return `null` when the file has no text that the parser can show. Throw only when the read failed.
- Give it a stable identity that includes its version and the configuration that matters. Keep the parser and its configuration immutable, and do not change the file.
- `identityFor(path)` gives the identity of the format that reads one file, or `null` when the parser does not handle it. A composite parser uses it, so that a new audio model does not invalidate the text of other formats.
- A parser does not depend on a source or a destination.
- The identity of the parser is part of the checkpoint binding of the copy. A new identity needs a new copy ID or a reset of the checkpoint.
- Keys and cursors stay metadata fields. A checkpoint is acknowledged only after the rows before it commit.
- `MacOSDocumentParser` is the parser of the Apple sources. See [source-apple-macos](../sources/apple/macos/README.md#parsing).

Airbyte has the same two concepts on the source side: its [file parser Strategy](https://github.com/airbytehq/airbyte-python-cdk/blob/f77450f74def59598cda8e1e9a4e975031710c18/airbyte_cdk/sources/file_based/file_types/file_type_parser.py) reads files, and its [file transfer](https://docs.airbyte.com/platform/using-airbyte/sync-files-and-records) moves the original content with its metadata. The parser of elt gives plain text, not the Markdown of Airbyte. elt does not claim the full format and OCR support of Airbyte, or wire compatibility.

### Attachment text

A copy can store files with no parse: an `attachmentRef` column and no `content` column. The import then never waits for a parse, and a file that the parser cannot read fails no copy. The text of the stored files is derived data, not a source, because its input is what the pipeline wrote. Declare it as a [computed dataset](../destinations/sqlite/README.md#declare-a-computed-dataset) with the `DocumentText` rule. The pipeline reads the files after each pass. [Context Compiler](https://github.com/ezzabuzaid/context-compiler/blob/main/docs/connectors-and-hosts.md) keeps an `attachment_text` view in this way, which SQL joins on `attachmentRef = ref`:

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

for await (const { connection, outcomes } of pipeline.watch({
  signal: controller.signal,
})) {
  // This pass's copies have already extracted, loaded, and saved their checkpoints.
}

// Call controller.abort() from your app's stop/shutdown handler.
```

- The watch checks the declarations of each connection first. Then each connection watches its own source. It subscribes before its first pass, and it runs a pass over the copies whose streams changed.
- The copies keep their modes. Incremental copies of Notes and Calendar stay incremental, and full refresh copies stay full refresh. A change notice does not give records, and it does not make a full refresh copy incremental.
- `run()` stays one execution. The hosts of [Context Compiler](https://github.com/ezzabuzaid/context-compiler/blob/main/docs/connectors-and-hosts.md) call the two.

The source owns the detection of changes. For example, the [EventKit SDK](../sdks/apple/eventkit/README.md#watch) watches Calendar and Reminders, and the [Notes source](../sources/apple/notes/README.md#watch) watches the store of Notes.

Passes and checks:

- The passes of one connection run one after the other. The passes of different connections run side by side, and each waits only for the consumer. Thus a slow source never holds back a different source.
- Changes that come while a pass extracts, or while the caller handles a result, go into the set of pending streams of that connection. They cause one next pass, not a queue with no limit.
- The first check of a connection must cover each stream that it selected.
- Each yield of the source is one check of the upstream. A check that names no stream tells that the upstream did not change.
- At each check, a stream is current as of that check when it has no pending change, no pass reads it, and its last copy loaded completely. When its source tells that its upstream was last current at an earlier time, the stream is current as of that earlier time.
- The pipeline gives each check to `checked()` of its sync history. `checked()` records the first check of a connection at once, and after that at most one time each minute. Only then does it ask the source. Thus `current_as_of` keeps moving while nothing changes, and it stops where the upstream stopped.
- A stream whose change failed to load stays current only as of the time before that change. Thus a failed refresh shows as a `current_as_of` that gets older. A Debezium heartbeat and a Beam watermark on an idle partition show in the same way that a source is caught up.
- Each pass yields a `Pass`, `{ connection, outcomes }`, after its load and its checkpoints are durable. Each outcome has the committed `count` and `deleted` and its `failures`, which is empty when the copy loaded completely. The counts are accepted observations, also deduplication no-ops and keys that were not there.
- A pass that did not load completely does not end the watch, as Airbyte keeps the schedule of a connection after a failed sync. The caller sees its failures, and the failed partitions keep their checkpoints. See [ADR 0010](./docs/adr/0010-a-watch-keeps-watching-after-an-incomplete-pass.md).

Retries:

- A stream whose copy failed for a `system` reason, by any one of its failures, loads again with no change. The platform of Airbyte also tries a failed sync attempt again, with these delays for an attempt that made no progress: 10 seconds after the failure, then 30, 90 and 270 seconds after each next failure in a row.
- After the fifth failure in a row, the stream waits for the next change of its source, and that change starts the count again.
- A pass that loads the stream completely stops the count. Records that a failed pass committed do not change the wait.
- A stream whose copy failed only for `config` reasons does not load again until its source reports a change, because only the user can fix it.
- A change that the source reports loads its stream at once, also while the stream waits for a retry. A change to a different stream does not bring a retry earlier.
- Retries stop when the watch stops. While a stream waits, its `current_as_of` does not move.
- See [ADR 0011](./docs/adr/0011-a-watch-loads-a-stream-again-after-a-system-failure.md).

When a watcher fails:

- A watcher that fails for a `system` reason, such as a connection that its upstream dropped, watches again. The pipeline waits 10, 30, 90, 270 and 810 seconds after each failure in a row, then 30 minutes after each next failure, with the back-off of Airbyte. It does not stop for a `system` failure, as the schedule of Airbyte continues after a failed sync and Debezium restarts its task.
- The sync history records each failure as a failed attempt. A check that the new watcher yields starts the count again. Its first check covers each selected stream, so each stream loads again.
- A connection whose watcher fails for a `config` reason stops alone, because only the user can fix it. The sync history records it as a failed attempt. The other connections continue.
- A watcher that breaks its contract stops its connection: it yields a stream that the connection did not select, or its first check does not cover each selected stream, or it ends before that check.
- See [ADR 0016](./docs/adr/0016-a-watch-watches-again-after-its-watcher-fails-for-a-system-reason.md).

When a watch stops:

- When each connection stopped, or the signal aborts, the watch throws the errors of the stopped connections together as a `WatchError`. A `WatchError` is an `AggregateError`. Its message joins entries `Connection <name>: <message>`, and each error has the error of the watcher as its `cause`.
- A `WatchError` holds only failures that the sync history recorded. An error that the sync history throws itself, such as a write that fails or an error of the host code in a history wrapper, is recorded nowhere. It stops each connection at once, and the watch rejects with that error itself.
- When the history cannot record why a watcher stopped, the watch rejects with a `SuppressedError`. Its `error` is the error of the history, and its `suppressed` is the error of the watcher.
- The pipeline does not reconcile on a schedule, and it does not disable a connection.

Stop:

- An abort stops the observation of the upstream. It stops each pass that runs, as `run({ signal })` does: the history records the pass as `cancelled`, and the watch yields it with that outcome. No other pass starts.
- Each connection then waits for the watcher of its source to stop, for example for the end of a helper process, for at most one second. A watcher that ignores the signal stays behind, so one source cannot hang the stop of its host.
- A `break` out of the loop also closes the watchers and stops the pass of each connection. The history records that pass as `cancelled`.
- A new watch subscribes again and makes a first pass again, from the saved checkpoints.
- Change notices are not durable. The limits of the snapshot or the cursor of the source still apply.

A custom source:

- It declares a `catalog`.
- It implements `observe({ streams, signal }): AsyncIterable<readonly Stream[]>`. On each check, it yields the streams that changed since the earlier check, or an empty list when none changed. A source that checks only some streams at a time, such as Search Console and SQL Server, yields only what changed.
- It implements `coverage(stream): ExtractionCoverage`, what a pass over the stream asks the upstream for (see [coverage](#coverage)).
- The base `Source` owns `discover()`, `validate()` and `watch()`. Before it extracts or observes, it refuses each stream that is not the same object as the stream of that name in its catalog. The schema of a stream shapes the destination, so it refuses a different stream with the same name.
- Add rules of the source, such as a cursor field that it requires, in `validateExtraction()`.
- In `observe()`, start the observation, then yield all selected streams one time. Then emit the selected streams that changed, until the signal aborts. The connection continues to read these changes while it loads records.
- Close native resources when the signal aborts or when the iterator closes. Errors must propagate.
- `Stream` stays immutable metadata. The load goes through `Source.read`, `Copy` and the writers of the destination.

The tests cover real file system events in temporary storage, the watch subscription of the EventKit helper and its stop on abort, and that the destination and the checkpoints show the data before the watch yields the results. The native file system test needs an environment that permits file system notices. The command sandbox of this host reports `EMFILE` also for one watcher of a temporary folder, and the same probe works outside the sandbox.

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
import { PipelineError } from '@workspace/elt';

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
- A failure after rows committed, such as a checkpoint that the store could not save or a cleanup error after the publication, shows in the same way, with the committed counts. It does not mean a rollback.
- A count of zero also covers an empty input that committed.
- A `PipelineError` holds only failures that the sync history recorded. A pass that could not run, such as a pass whose sync history the pipeline could not write, is recorded nowhere. Thus `run()` rejects with that error itself, after each other pass ends.
- When the history cannot record why a connection failed its validation, `run()` and `watch()` reject with a `SuppressedError`. Its `error` is the error of the history, and its `suppressed` is the error of the validation.

`run({ signal })` stops a run on request, as Airbyte cancels a sync:

- When the signal aborts, each pass applies no more messages. Each copy that still reads drops what it staged after its last commit, keeps what it committed and the checkpoints that it saved with it, and ends `cancelled`. A copy that ended before keeps its outcome.
- The [sync history](#sync-history) records the pass as `cancelled`, with the reason of the signal as its error. Then `run()` rejects with `signal.reason`, as `fetch` does.
- `Source.read(catalog, states, signal)` gives the signal to `open(streams, signal)` and to each `extract` as its last argument. Thus a source that waits for its upstream can stop at once. A source that ignores it stops at its next message.
- A [snapshot diff](#snapshot-streams) yields no message while it finds no change, so it stops itself at the next record or group.

The destination contract:

- Declarations are frozen, and you can use them again.
- `Destination.createWriter(configuration, target)` selects a strategy of the storage with no I/O.
- `Destination.load()` opens the one hold of the pass on the storage.
- `load.prepare(configuration, target, { writer, reloading })` gives each stream its `Stage`. A `Stage` has `apply`, `commit` and `discard`. It also has `fresh`, which is true when the target holds none of the earlier rows of the copy, so the copy reads from no checkpoint; `reloading`, which is true while commits go to a hidden target; and `complete`, which puts that hidden target in the place of the target after the stream ends with no failure.
- Each destination uses `reloadMode` to decide what to do with the target: load into it, make it, evolve a stored target that the stream does not fit now ([shape changes](#shape-changes)), open a reload for an overwrite whose stored target does not fit now, or continue the reload that the last run of the copy left open. A `RESET` of the full stream also opens a reload.
- Destinations own connections, files and publication. `Copy` and `Pipeline` have no SQL or file system code of a load.
- `Source.identity` and `Destination.location(target)` give stable checkpoint bindings. The scope of a stored file is the location of the target, the writer of the copy and the file field.
- The identity of a source names what it reads, its kind and what changes which records exist (`sql-server:<database>`). It never names where its store is. Thus a store that moves to a different Mac or home folder keeps its checkpoints. A host that reads a second store of one kind keeps it apart with its own checkpoint store.
- A custom destination names each stored object by its address in the destination, never by where the destination is.

The locks and commits of each destination are in [elt-sqlite](../destinations/sqlite/README.md#locks-and-commits) and [elt-postgresql](../destinations/postgresql/README.md#locks-and-commits).

Live check on 2026-09-26 (macOS 26.6.2): the Apple exporter ran two times against the real stores.

- The first run loaded each stream (Messages 12,573 messages, Calendar 10,941 events) in 203 s.
- The second run took 168 s. It wrote nothing for Notes, Messages, Contacts and Reminders. For Calendar it wrote only 2 events (with 1 alarm and 2 recurrence rules) that had just come into its window of one year, and 1 account that EventKit listed for the first time.
- A run that was killed while it wrote left a hot journal, and SQLite rolled it back at the next open. Nothing that it staged was published.
- The Search Console exporter loaded each stream into the Postgres warehouse on the same day.

## Sync history

As the platform of Airbyte keeps the jobs and attempts of each connection apart from each connector, the orchestrator records each pass in a `SyncHistory`, from `elt`. Like a `CheckpointStore`, it belongs to the orchestration. Give it as `Pipeline({ connections, history })`. The SQLite history is in [elt-sqlite](../destinations/sqlite/README.md#sync-history), and the Postgres history is in [elt-postgresql](../destinations/postgresql/README.md#sync-history).

The contract:

- `validate(connection)` refuses, with no I/O, a connection that the history cannot record. The pipeline calls it when it validates.
- `install(connections)` brings the storage of the history to its declaration. The pipeline calls it when it validates, after `validate` and before a read, on each run and watch. Thus no host calls it, and it is safe to repeat. See [ADR 0013](./docs/adr/0013-the-pipeline-installs-its-sync-history-before-each-run-and-watch.md).
- `begin(connection, copies)` gets each selected copy with its `coverage`. It is durable when it resolves, before the read starts. Thus a pass that never ends stays visible as unfinished, not missing.
- `begin` returns a `RecordedPass`. `finish(outcomes, upstream)` closes it with what each copy loaded and, for each stream, when its source told that its upstream was last current. `fail(error, failureType)` closes a pass that gave no outcomes, such as a connection that is not valid or a watcher that stopped.
- A pass ends `succeeded`, `partial`, `failed` or, when the signal of its run stopped it, `cancelled`.
- A subclass implements `recordChecks(connection, checks)`, which is durable when it resolves. Each check is a `StreamCheck`, `{ stream, at }`. `checked()` calls it for the first check of a connection at once, and then at most one time each minute, because each record is a write.
- The helpers `copyStatus`, `passStatus`, `passError` and `passFailureType` get from the outcomes the status (`SyncStatus`), the error text and the failure type of a copy or a pass. `recordedFailure` makes the failure entry that the two histories store. `DeclaredCopy` and `RecordedPass` type the contract.

```ts
import {
  PostgresCheckpointStore,
  PostgresDestination,
  PostgresSyncHistory,
} from '@workspace/elt-postgresql';

const url = 'postgres://warehouse:warehouse@127.0.0.1:55432/warehouse';
const warehouse = new PostgresDestination({ url, schema: 'apple_notes' });

const history = new PostgresSyncHistory({ url });

const recorded = new Pipeline({
  history,
  connections: [
    new Connection({
      name: 'apple-notes',
      source: notes,
      destination: warehouse,
      checkpoints: new PostgresCheckpointStore({ url, schema: 'apple_notes' }),
      steps: [
        new Copy(notes.notes, warehouse.table('raw_notes'), {
          id: 'apple-notes:notes',
          syncMode: 'incremental',
          destinationSyncMode: 'append_dedup',
        }),
      ],
    }),
  ],
});
```

### Pass observer

To show passes while they run, for example in a terminal, give a `PassObserver` as `Pipeline({ connections, history, observer })`.

- Its `begin(connection)` returns an `ObservedPass`.
- `progress(progress)` sees each copy as a `CopyProgress`: its `status` (`running`, then one time `complete` or `incomplete`), and the records and deletions that the source `emitted` and that the destination `committed` until then.
- `finish(outcomes)` and `fail(error, failureType)` see how the pass ended, each after the history recorded it.
- The observer only advises. The pipeline does not wait for it. What it throws is ignored, and it never changes what loads or what the history records. Nothing keeps what it sees.

### Failure types

Each failure tells whose it is to fix, as the `failure_type` of Airbyte does (`AirbyteTracedException`, `airbyte-python-cdk` `utils/traced_exception.py`). See [ADR 0012](./docs/adr/0012-every-failure-says-whose-it-is-to-fix.md).

- Each `LoadFailure` has a `failureType`. The source decides it with `failureType(error): FailureType`.
- `config` means that the upstream refused what the user set up or granted, so only the user can fix it. `system` is for each other error, also the errors of a destination.
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
- `loaded_at` tells of the load that last wrote a row.
- `last_successful_sync_at` tells when a recorded pass ended.
- `current_as_of` tells when a stream last agreed with its upstream: the start of its last successful pass, or a later watch check that found it unchanged. It is never later than when its source tells that the upstream itself was last current. Use it to judge freshness.

What the history does not prove:

- Table timestamps and the end of a pass do not tell that a watcher is healthy.
- An attempt that stays `running` means only that its end was not recorded, also after a process stopped or could not keep its outcomes.
- The metadata and the commits of the destination are separate. Metadata that did not end never tells of success.
- The set up of credentials or of a source before the pipeline is made is not part of the recorded attempt.
- Missing metadata means unknown. It does not mean empty or current.

## Declare derived datasets on the pipeline

```ts
import { DocumentText, LocalFiles, Pipeline } from '@workspace/elt';
import {
  ComputedDataset,
  SQLiteSyncHistory,
  View,
} from '@workspace/elt-sqlite';
import { MacOSDocumentParser } from '@workspace/source-apple-macos/macos-document-parser';

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
        files: files.directory,
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

`connection` copies a stream into the table `documents`, and `files` is the `LocalFiles` that keeps its stored files. Each kind of derived dataset is a class of a destination package. The SQLite destination has `View` and `ComputedDataset`; see [elt-sqlite](../destinations/sqlite/README.md). The Postgres destination has no kinds yet. See [ADR 0001](./docs/adr/0001-derived-data-is-declared-on-the-pipeline.md).

## When the pipeline refreshes

- **A run** refreshes each derived dataset after the passes of all connections, also when some copies failed. Then it rejects with `PipelineError`. See [ADR 0002](./docs/adr/0002-a-run-refreshes-its-derived-data-also-when-copies-failed.md).
- **A watch** refreshes after each pass, in the background. One refresh runs at a time. A pass that commits while a refresh runs asks for one more refresh after it. Thus no pass waits for a refresh. See [ADR 0003](./docs/adr/0003-a-watch-refreshes-in-the-background-one-refresh-at-a-time.md).
- The pipeline refreshes the derived datasets in the order of the list. A view that comes after a computed dataset can read the view of that dataset.
- A run does not refresh after an abort, or after an error that no sync history recorded. A stop that comes after the passes only stops the refresh. The next refresh continues the work.

## Write a rule

A computed dataset gives each input to its rule. A rule is a class that extends `Rule<Input, Output>`:

| Member                    | Gives                                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| `key`                     | the name and the description of the key column, for example `ref`                                    |
| `output`                  | the columns that the rule adds to each output, each `text` or `blob`, with a description             |
| `batch`                   | how many inputs one call of `compute` takes, for example the texts of one model call                 |
| `concurrency`             | how many calls of `compute` run at the same time, for example files that are parsed side by side     |
| `read(row)`               | the key and the input of one loaded row, or `null` when the row has no input                         |
| `identity(input)`         | the rule identity of the input, or `null` when the rule does not handle it                           |
| `compute(inputs, signal)` | one output for each input, in order: `{ value }`, `{ empty: true }`, `{ error }` or `{ gone: true }` |

The dataset makes an output again when its input or its rule identity changes. See [ADR 0005](./docs/adr/0005-an-output-is-made-again-when-its-rule-identity-changes.md).

Two rules exist:

| Rule                                      | Package                | Input                                                | Output                                                                                                       |
| ----------------------------------------- | ---------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `DocumentText({ parser, files, column })` | `@workspace/elt`       | the ref in `column`, relative to the folder `files`  | `content`, the text that a `DocumentParser` reads. The rule identity is the parser of the format of the file |
| `Embedding({ model, key, fields })`       | `@workspace/embedding` | the text of `fields`, with a line break between them | `vector`, from an AI SDK embedding model. The rule identity is the provider and the id of the model          |

`DocumentText` asks for its parser at each refresh, so a parser that the host changed, for example a new speech model, applies from the next refresh.

## When a derived dataset fails

- **A rule failure** is the output of its input: the status `failed` and the reason. The load and the run continue, and the next refresh tries the input again. See [ADR 0004](./docs/adr/0004-a-rule-failure-stays-on-its-output.md).
- **A dataset failure**, for example SQL that SQLite refuses, rejects the run as itself, or it stops the watch.
- **A copy that failed** keeps its last committed rows. The derived data of those rows stays as it was.

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

## Decisions

- [ADR 0001](./docs/adr/0001-derived-data-is-declared-on-the-pipeline.md): derived data is declared on the pipeline.
- [ADR 0002](./docs/adr/0002-a-run-refreshes-its-derived-data-also-when-copies-failed.md): a run refreshes its derived data also when copies failed.
- [ADR 0003](./docs/adr/0003-a-watch-refreshes-in-the-background-one-refresh-at-a-time.md): a watch refreshes in the background, one refresh at a time.
- [ADR 0004](./docs/adr/0004-a-rule-failure-stays-on-its-output.md): a rule failure stays on its output.
- [ADR 0005](./docs/adr/0005-an-output-is-made-again-when-its-rule-identity-changes.md): an output is made again when its rule identity changes.
- [ADR 0006](./docs/adr/0006-a-stream-whose-fields-change-keeps-its-rows-and-its-checkpoint.md): a stream whose fields change keeps its rows and its checkpoint.
- [ADR 0007](./docs/adr/0007-a-stream-that-starts-over-reloads-into-a-hidden-target.md): a stream that starts over reloads into a hidden target.
- [ADR 0008](./docs/adr/0008-a-target-has-one-writer.md): a target has one writer.
- [ADR 0009](./docs/adr/0009-a-target-is-named-by-its-address-inside-the-destination.md): a target is named by its address inside the destination.
- [ADR 0010](./docs/adr/0010-a-watch-keeps-watching-after-an-incomplete-pass.md): a watch keeps watching after an incomplete pass.
- [ADR 0011](./docs/adr/0011-a-watch-loads-a-stream-again-after-a-system-failure.md): a watch loads a stream again after a system failure.
- [ADR 0012](./docs/adr/0012-every-failure-says-whose-it-is-to-fix.md): every failure says whose it is to fix.
- [ADR 0013](./docs/adr/0013-the-pipeline-installs-its-sync-history-before-each-run-and-watch.md): the pipeline installs its sync history before each run and watch.
- [ADR 0014](./docs/adr/0014-a-source-says-how-current-each-stream-s-upstream-is.md): a source says how current the upstream of each stream is.
- [ADR 0015](./docs/adr/0015-a-stored-file-s-ref-is-relative-to-its-folder.md): a stored file's ref is relative to its folder.
- [ADR 0016](./docs/adr/0016-a-watch-watches-again-after-its-watcher-fails-for-a-system-reason.md): a watch watches again after its watcher fails for a system reason.

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
  pipeline.ts           Pipeline: run, watch, retries, and the refresh after the passes
  replication.ts        one pass: checkpoints, the load and its stages
  connection.ts         Connection
  copy.ts               Copy, its outcome and its progress
  copy-configuration.ts the modes, keys, cursor and dedup policy of a copy
  source.ts             Source: read, watch, coverage, currentAsOf, failureType
  stream.ts             Stream: the metadata of one stream
  destination.ts        Destination and Load: the port of each destination
  reload-mode.ts        reloadMode: load, make, evolve or reload a target
  snapshot.ts           diffSnapshot and diffGroupedSnapshot
  partition.ts          the checkpoint of a partitioned stream
  identifiers.ts        Identifiers: the naming rule
  file-read.ts          FileRead and FileReference: the file declarations of a copy
  file-transfer.ts      the save, flush and retain of stored files around each commit
  file-storage.ts       FileStorage: the port of each file storage
  document-parser.ts    DocumentParser: the port of each parser
  formats/              the string formats
src/storage/
  local-files.ts        LocalFiles
src/state/
  checkpoint-store.ts   CheckpointStore: the checkpoint protocol
  sync-history.ts       SyncHistory and its helpers
  sync-history-relations.ts  the descriptions of the history views
```

The files of derived data:

```
src/core/
  derived-dataset.ts    DerivedDataset: the port of each kind
  derived-refreshes.ts  the refreshes of a watch, one at a time
  rule.ts               Rule, RuleResult, LoadedRow, RuleColumn
  document-text.ts      DocumentText: the text of each stored file
```
