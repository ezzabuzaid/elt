# API and behavior reference

[Back to the README](../README.md)

Detailed sync, storage, connector, and failure contracts for `elt`.

## Working example

The examples below import pipeline types from `elt`, the SQLite destination and checkpoint store from `elt-sqlite`, and each Apple source from its own package, `@workspace/source-apple-<name>` under `packages/sources/apple`. Later snippets reuse `notes`, `sqlite`, and `checkpoints` from this example.

```ts
import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
} from '@workspace/elt-sqlite';
import { AppleNotesSource } from '@workspace/source-apple-notes/apple-notes-source';

const notes = new AppleNotesSource();
const sqlite = new SQLiteDestination({ path: './notes.sqlite' });
const checkpoints = new SQLiteCheckpointStore({ path: './checkpoints.sqlite' });

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
const pipeline = new Pipeline({ connections: [connection] });

const results = await pipeline.run(); // [{ copy, count, deleted }, ...] in declaration order
```

A `Connection` is Airbyte's connection: one source's copies into one destination, with the checkpoints that resume them. Its `name` is what readers of sync history see. A `Pipeline` is the orchestrator over one or more connections; see [execution and failures](#execution-and-failures). Accounts uses an explicit destination projection; notes uses inferred columns and deduplicates on the stream's own `id` key. Apple Notes exposes `accounts`, `folders`, `notes`, `inlineAttachments`, and `attachments` directly. `discover()` returns the same immutable descriptions for generic code that enumerates streams. Neither discovery nor constructing a declaration reads Notes or opens storage.

## Sync modes

`syncMode` selects extraction. `destinationSyncMode` selects loading. Both SQLite and Markdown files/folders implement these five combinations:

| Extraction     | Loading           | Result                                                                                |
| -------------- | ----------------- | ------------------------------------------------------------------------------------- |
| `full_refresh` | `append`          | Retain every observation, including repeated IDs within and across runs.              |
| `full_refresh` | `overwrite`       | Replace the target with this extraction, preserving repeated IDs.                     |
| `full_refresh` | `overwrite_dedup` | Replace the target with the greatest cursor value per selected key.                   |
| `incremental`  | `append`          | Resume from acknowledged source state and retain each emitted observation.            |
| `incremental`  | `append_dedup`    | Resume from acknowledged state and reconcile each key with its greatest cursor value. |

Omitting the entire third `Copy` argument selects `full_refresh` + `overwrite`. An explicit options object requires both mode fields. Incremental + overwrite and full refresh + append_dedup are rejected; use `overwrite_dedup` for the latter outcome.

These combinations follow Airbyte's [documented sync modes](https://docs.airbyte.com/platform/using-airbyte/core-concepts/sync-modes). Its platform [maps Full Refresh Overwrite + Deduped to `full_refresh` + `overwrite_dedup`](https://github.com/airbytehq/airbyte-platform/blob/main/airbyte-server/src/main/kotlin/io/airbyte/server/apis/publicapi/helpers/AirbyteCatalogHelper.kt). Its [serializer](https://github.com/airbytehq/airbyte-platform/blob/main/airbyte-commons-protocol/src/main/kotlin/io/airbyte/commons/protocol/DefaultProtocolSerializer.kt) maps `overwrite_dedup` to `append_dedup` for refresh-capable destinations, using generation metadata, and to `overwrite` otherwise. The separate [wire protocol enum](https://github.com/airbytehq/airbyte-protocol/blob/main/protocol-models/src/main/resources/airbyte_protocol/v0/airbyte_protocol.yaml) does not include `overwrite_dedup`. This library uses the platform vocabulary and an in-process protocol; it does not claim Airbyte wire compatibility. The default and tie policy below are explicit library choices.

### Conflict policy for deduplicating loads

`dedupPolicy` selects how `append_dedup` and `overwrite_dedup` resolve a conflict on the selected key:

| `dedupPolicy`            | Upsert guard                                | Use when                                                                                     |
| ------------------------ | ------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `cursor_newer` (default) | `WHERE excluded.<cursor> > target.<cursor>` | The cursor advances independently of identity, so a lower cursor means a stale replay.       |
| `replace`                | none                                        | The upstream restates facts it already published, so the newest extraction is authoritative. |

A deduplicating copy that leaves `dedupPolicy` unset uses `cursor_newer`, or `replace` for a stream with `sourceDefinedCursor`. Both destinations apply the policy: SQLite as the upsert guard above, Markdown when it merges each record with the previously published one or with an earlier record from the same run.

Selecting `cursor_newer` with a cursor that is a member of the primary key is rejected. A conflict on that key implies an equal cursor, so the guard could never fire and a restated record would load as a no-op that reports a count without changing the row. The rejection names the field and points at `replace`.

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

Capabilities are immutable metadata:

```ts
notes.notes.supportedSyncModes; // ['full_refresh', 'incremental']
sqlite.supportedDestinationSyncModes;
// ['overwrite', 'append', 'append_dedup', 'overwrite_dedup']
```

### Deletions

A stream that declares `emitsDeletes` can send `DELETE` messages during incremental reads, each carrying exactly the stream's `primaryKey` fields. Such a stream always declares its key, and its incremental copies must use `append_dedup`, which deduplicates on that key, so the destination can find the row:

| Destination                            | Effect of `DELETE`                                           |
| -------------------------------------- | ------------------------------------------------------------ |
| SQLite `append_dedup`                  | Deletes the row with that key inside the copy's transaction. |
| Markdown `append_dedup` file or folder | Drops the record before the target is republished.           |

Records and deletions apply in the order the source emits them, and deleting an absent key is a no-op, so replaying a run is safe. A deletion is rejected when the stream does not declare `emitsDeletes`, when its key is malformed, or when the load does not deduplicate. Results report accepted deletions as `deleted`, separately from `count`.

### Resets

A stream that emits deletions can also send `{ type: 'RESET', stream }` when the upstream can no longer say what changed since the checkpoint, as when its change history expired. The stream starts over in a hidden target: what it emits after the reset, checkpoints included, commits there, and readers keep the previous rows until the stream ends without a failure, when the hidden target takes the target's place. A reload that fails stays hidden and the next run resumes it from its last checkpoint, since the engine saves with each checkpoint whether a reload is open; a hidden target no checkpoint continues is dropped, and a new reset starts the reload over. A stream whose fields changed, or whose stored table no longer fits it, reloads this way only when its copy overwrites; otherwise its target [evolves](#shape-changes). For a partitioned stream a reset covers only the partition being read: its next commit drops that partition's rows, keeping only what the source emits after the reset. Operations staged before a reset in its scope are dropped with it. `Source.read` scopes each reset to its partition; a reset in a full refresh is ignored, since a full refresh starts over anyway, so an appending copy keeps its history.

### Shape changes

A stream's shape is its fields and their types (its schema, without descriptions) and its declarations: its name, primary key, partition key, sync modes, file transfer, source-defined cursor, deletions and expiry. As in Airbyte, whose [schema-change management](https://github.com/airbytehq/airbyte/blob/f847ad015360face1837f5a77c64325f104157f0/docs/platform/using-airbyte/schema-change-management.md#L26-L31) never re-reads a source on its own, a shape change keeps what was loaded:

- **Changed fields** (added, removed, retyped, made nullable or required) keep the copy's checkpoint and its rows. Before anything is read, the destination evolves its stored target to the new shape in place, as Airbyte's direct-load destinations [alter a table](https://github.com/airbytehq/airbyte/blob/f847ad015360face1837f5a77c64325f104157f0/airbyte-cdk/bulk/core/load/src/main/kotlin/io/airbyte/cdk/load/component/TableSchemaEvolutionClient.kt#L59-L111): an added column reads NULL on the rows loaded before it, a removed one is dropped, a retyped one is converted. A stored value the new type cannot hold fails the copy, naming the column, and leaves the table and checkpoint as they were; clear the copy to load it again, or change the stream so the value fits. Rows the upstream no longer holds, such as notifications it forgot or activity it expired, survive the change. An overwrite (`overwrite` or `overwrite_dedup`) replaces every row anyway, so its stored target instead reloads into a [hidden target](#resets) of the new shape, swapped in when the stream ends, as Airbyte's truncate syncs [load a new table](https://github.com/airbytehq/airbyte/blob/f847ad015360face1837f5a77c64325f104157f0/airbyte-cdk/bulk/core/load/src/main/kotlin/io/airbyte/cdk/load/table/directload/DirectLoadTableStreamLoader.kt#L222-L246) rather than alter one holding an earlier sync's rows.
- **Filling a field in** is the source's job, since the copy resumes from its checkpoint. A snapshot diff re-emits every record whose fields changed, since its fingerprint changes. A cursor source whose cursor cannot see a column the table gained records the fields it read in its state and reads every row again when one is added, as the [SQL Server](#sql-server) source does; Airbyte leaves this to a [backfill](https://github.com/airbytehq/airbyte-platform/blob/090c5e993543735758a60184546fe87354af3d32/airbyte-commons-worker/src/main/kotlin/io/airbyte/workers/helper/BackfillHelper.kt#L100) setting that clears the state.
- **Changed declarations** stop the copy with `StreamChangeError`, which names them, as Airbyte pauses a connection whose primary key or cursor was [removed](https://github.com/airbytehq/airbyte-platform/blob/090c5e993543735758a60184546fe87354af3d32/airbyte-commons-protocol/src/main/kotlin/io/airbyte/commons/protocol/CatalogDiffHelpers.kt#L320-L350). The host chooses: `CheckpointStore.reset(id)` keeps the stored rows and loads on from no checkpoint, as Airbyte's refresh that retains records, and `pipeline.clear()` drops them, as Airbyte's Clear. A copy whose own `cursorField` the stream no longer describes is refused before anything is read; the copy must choose another cursor, which changes its binding, so the host resets it too.
- **Stored nullability:** a stored table is `NOT NULL` only on `loaded_at` and explicit primary-key columns, since a field added later has no value on earlier rows; Airbyte's Postgres destination likewise adds columns nullable, as it does not "know what constitutes a reasonable default value for preexisting records" ([source](https://github.com/airbytehq/airbyte/blob/f847ad015360face1837f5a77c64325f104157f0/airbyte-integrations/connectors/destination-postgres/src/main/kotlin/io/airbyte/integrations/destination/postgres/sql/PostgresDirectLoadSqlGenerator.kt#L608-L615)). Every record written is still checked for its required fields, and a deduplicating load refuses NULL keys and cursors.

### Target ownership

A target has one writer, as in Airbyte, where one stream owns one table and ["more than one Airbyte connection to sync to the same destination stream… isn't permitted"](https://github.com/airbytehq/airbyte/blob/65c1b23b53ca4929ff18adbc3a3ef92666a3fffe/docs/platform/using-airbyte/configuring-schema.md#L42-L54). An overwrite empties the whole target and a snapshot copy deletes keys it once saw, so a second writer's rows would be lost.

A writer is the copy's `id`, or the source identity and stream name for a copy without one. Every destination records the writer of each target, stored with the target and committed with its first load. Before a copy extracts or changes anything, the target refuses any other writer with `TargetOwnedError`, which names both. A pipeline refuses two writers of one target among the copies of all its connections before running any. It compares each destination's `location(target)`, which is globally unique: `//host:port/database/"schema"."table"` for Postgres, `<path>#<table>` for SQLite, and `<directory>/<name>` for Markdown. The owning writer may change its own mode or key.

To reset or reassign a target, clear it with its owning copy, as with Airbyte's Clear: `pipeline.clear()` (or `pipeline.clear([copy])`, which routes each copy to its connection, or `connection.clear()`) empties each target, releases its writer and removes the copy's checkpoint, so the next run reloads from scratch. A SQL table is emptied rather than dropped, so views built on it, such as the warehouse marts, keep working; a Markdown file or folder is removed. Clearing refuses a target another writer owns. A target dropped by hand also releases its writer, and its copy reloads it from no checkpoint, since resuming would load only what changed since the checkpoint. SQLite and Postgres keep writers in the reserved `_elt_writers` table; Markdown keeps it in the file's header comment or the folder's marker file.

Several properties or accounts share tables through one [partitioned source](#partitioned-streams), which is one writer.

## Identity, cursors, and schemas

Three separate concepts control identity:

- `Stream.primaryKey` is the source's own identity, like `sourceDefinedCursor` (Airbyte's `source_defined_primary_key`). A deduplicating copy of a stream that declares one uses it; it does not create SQL uniqueness or select deduplication by itself.
- `Copy` option `primaryKey: ['id']` or `['tenantId', 'id']` selects the identity only for a stream that declares none. A copy that selects `primaryKey` on a keyed stream is refused at construction (`Stream <name> defines its own primary key; omit primaryKey`).
- `.primaryKey()` on a SQLite column is a physical constraint. Conflicting append operations fail and roll back that copy; they never silently become updates.

Both deduplication modes need a key: the stream's own, or for a keyless stream the copy's `primaryKey` (`Stream <name> declares no primary key; select primaryKey` otherwise). Non-deduplicating loads refuse `primaryKey`. `cursor_newer` also requires `cursorField`; `replace` works without one. A stream with `sourceDefinedCursor` has no cursor field: its copies omit `cursorField`, and its deduplicating loads default to and require `replace`. Fields must be top-level scalar properties declared with one non-null JSON Schema type. Keys support text, finite numbers, safe integers, and booleans; cursors support text or numbers. A key or cursor with a [string format](#string-formats) must be in its canonical spelling; `decimal` and base64 fields can be keys but not cursors, since their text does not sort as their values do. Missing/null values fail. Composite keys are supported; nested field paths and nullable key/cursor schemas are not. Explicit SQL projections must include all selected keys and the cursor with matching types.

The greatest cursor wins. Older arrivals are ignored after validation. Equal cursors retain the first stored record, including across runs. This makes replay deterministic; a source that changes content without changing its cursor cannot distinguish those versions. Text uses UTF-8 byte order, matching SQLite `BINARY`, except `int64` text, which compares as 64-bit integers. Every value of a `date`, `date-time`, `date-time-local` or `time-local` field has the same width, so its byte order is time order. All observations are validated, even losing versions.

Stream properties are scalars or arrays of one scalar type. An array field declares `type: 'array'` (or `['array', 'null']`) and an `items` schema carrying the element's type, `enum`, range, `minLength` and date `format`; `validateRecords` checks every element, and constraints on the array itself are refused. Arrays hold lists of values, such as keywords or daily counts. A collection whose members have fields of their own stays a separate stream of rows. Arrays cannot be keys or cursors.

### String formats

A string property can declare its spelling, so values that a JSON number or a JavaScript `Date` would round travel exactly. `validateRecords` accepts exactly one spelling of each value:

| Schema                                                 | Value                                                                                   | Example                        |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------ |
| `format: 'date-time'`, `precision` 0–9 (3 when absent) | A UTC instant ending in `Z`, with exactly `precision` fraction digits                   | `2025-01-02T03:04:05.1234567Z` |
| `format: 'date-time-local'`, `precision` 0–9 (3)       | A wall-clock date and time with no zone                                                 | `9999-12-31T23:59:59.9999999`  |
| `format: 'time-local'`, `precision` 0–9 (3)            | A time of day with no zone                                                              | `23:59:59`                     |
| `format: 'date'`                                       | A calendar date                                                                         | `2024-02-29`                   |
| `format: 'int64'`                                      | A signed 64-bit integer without leading zeros                                           | `-9223372036854775808`         |
| `format: 'decimal'`, optional `precision` and `scale`  | An exact decimal: exactly `scale` fraction digits when declared, else no trailing zeros | `922337203685477.5807`         |
| `contentEncoding: 'base64'`                            | Bytes as padded RFC 4648 base64                                                         | `AAEC/w==`                     |

`date-time-local`, `time-local`, `int64` and `decimal` are names from the OpenAPI format registry; JSON Schema's own `time` requires an offset, so it cannot carry a time of day without one. `precision` and `scale` mean what they mean in SQL. A declaration that combines these keywords any other way, or puts them on a non-string type, is refused. Each destination stores a format in a type that keeps it exact (see the SQLite and [Postgres](#postgres-destination) mappings).

SQLite inference maps flat JSON Schema fields: `string` → `TEXT`, `integer` → `INTEGER`, `number` → `REAL`, `boolean` → `INTEGER` with a 0/1 constraint, and an array → `TEXT` holding a JSON array, checked by `json_valid` and `json_type(...) = 'array'` and read with `json_each`. Of the [string formats](#string-formats), `int64` loads as `INTEGER`, base64 as `BLOB`, `decimal` as `TEXT`, and the four temporal formats as `TEXT` with a `CHECK` that keeps the canonical spelling and width; the catalog's `data_type` names each with its precision and scale, such as `timestamp(7)` or `decimal(19,4)` (a millisecond `date-time` stays `timestamp`). Nullable scalars and arrays are supported for ordinary fields. Missing optional fields become SQL `NULL`. Explicit columns support `text`, `integer`, `real`, `blob`, and `boolean`; they allow null unless marked `.notNull()` or `.primaryKey()`. Missing/undefined explicit fields fail. An explicit projection can omit unsupported nested fields.

SQLite creates strict tables. Existing SQL constraints remain authoritative. When a table's stored definition no longer matches the stream's columns, the load [evolves it](#shape-changes) before anything is read: SQLite cannot change a column's type or constraints in place, so in one transaction the rows move, column by name, into a table of the new definition, which takes the table's name with its index and reader view; a value its type or a CHECK refuses fails the load and leaves the table as it was. An overwrite reloads such a table into a hidden `_elt_next_<hash>` table instead, which replaces it and its reader view when the stream ends ([resets](#resets)). Table and column names follow the [naming rule](#names). Deduplication additionally verifies stored key/cursor column types and rejects null keys/cursors. It uses native [UPSERT with a cursor comparison](https://www.sqlite.org/lang_upsert.html) and a reserved `_elt_dedup_*` unique index. Changing to ordinary append/overwrite removes that mode-owned index while retaining explicit constraints. An existing append-history table with repeated keys must be replaced with `overwrite_dedup` before incremental deduplication can start.

Every SQLite copy adds `loaded_at`, the UTC start time of the load. A field with that name gets another column name ([names](#names)). The `count` returned for a committed copy is the number of accepted input observations, including deduplication no-ops, and `deleted` is the number of accepted deletions, including keys that were already absent; neither is the final row count.

### Names

A SQL destination gives each column, table and reader view a name that it can hold. It uses the rule that Airbyte uses, so a field with any name loads:

1. Unicode decomposition separates each mark, and the mark is removed (`spécial` becomes `special`).
2. Each run of whitespace becomes one `_`.
3. Each other character outside `[A-Za-z0-9_]` becomes `_` (`名前` becomes `__`). The case stays.
4. A name that starts with a digit gets a `_` in front (`1st` becomes `_1st`).
5. A name that starts with `_elt_` loses its first `_` (`_elt_seq` becomes `elt_seq`), because elt names its own tables and columns with `_elt_`.
6. An empty name becomes `_`.

Columns get their names in field order. When an earlier column already has the name, the field gets `_1`, then `_2`, and so on after it (`a b` becomes `a_b`, and a later `a_b` becomes `a_b_1`). The names that the destination writes itself come first: `loaded_at` in both destinations, and the system column names `xmin`, `xmax`, `cmin`, `cmax`, `ctid` and `tableoid` in Postgres (`loaded_at` becomes `loaded_at_1`). Postgres compares names with their case. SQLite compares names without ASCII case, so `Foo` and `foo` become `Foo` and `foo_1`.

A table or view does not see the names of other tables. When the rule changes its name, the name gets `_` and the first 8 hex digits of the SHA-256 of the requested name (`dbo.a b` becomes `dbo_a_b_<hash>`). Thus two requested names never share a table.

Postgres keeps only 63 bytes of a name. A longer name keeps its first 54 bytes, then `_` and the first 8 hex digits of the SHA-256 of the field or requested name. SQLite has no length limit.

When the rule changes a column name, the column description ends with `Source field: "<field>".` The catalog shows that description, so a reader can find the field. The names depend only on the stream's fields, so each run gives the same names. A change of fields evolves the stored table ([shape changes](#shape-changes)).

Schema names and the names of published views do not change, because the caller's SQL uses them. A destination refuses such a name when it cannot hold it.

## Incremental extraction and checkpoints

Incremental copies require an explicit stable `id` and a [checkpoint store](#checkpoint-stores). IDs must be unique across every connection of a pipeline, and each ID's progress is its own. A connection copies each stream once, so loading one stream into two targets takes two connections with two IDs (see [Read context](#read-context)).

`Source.read(catalog, states)` hands each incremental stream its saved state, `null` on its first run, and `extract` receives it as `state`. `extract` emits `{ stream, data }` records, `{ type: 'DELETE', stream, key }` deletions, `{ type: 'RESET', stream }` [resets](#resets) and `{ type: 'STATE', stream, state }` checkpoints. Their text must be well-formed Unicode: a string or field name with a lone surrogate fails its stream, because SQLite and Markdown would store it as U+FFFD and Postgres refuses it. State is losslessly JSON serializable and source-owned; destinations do not interpret it.

Each checkpoint is a commit point, as in Airbyte: the writer commits everything before it, then acknowledges it, and the store saves it before the load continues. A run that fails later keeps every checkpoint it acknowledged and resumes from the last one. No acknowledgement means no advancement, even if the source mutates its input state. When `extract` throws, `Source.read` reports a `FAILED` stream status (Airbyte's error trace) for that partition or stream instead of throwing; the stream's stage discards what it staged since its last checkpoint and commits nothing more until the next one. A connector signals a failed read by throwing, never by yielding nothing. A full refresh carries no checkpoints, so it commits once at the end and any failure keeps the previous target.

The store binds each ID to its copy (the source identity, the target's `location`, and the selected configuration) and to the shape of its stream (its schema, key and sync modes, without descriptions). A target's columns are not part of the binding, so a changed field keeps the checkpoint even when the target declares its columns, and the destination evolves its target; a changed declaration stops the copy with `StreamChangeError` until it is reset or cleared ([shape changes](#shape-changes)). A changed description only updates the target's comments. A changed copy fails before extraction; use a new ID or explicitly reset progress:

```ts
await checkpoints.reset('notes-to-sqlite'); // Next read starts from null; destination data is unchanged.
await pipeline.run();
```

`reset` keeps the loaded rows, as Airbyte's refresh that keeps records: resetting append progress may duplicate data, and resetting deduplicated progress reconciles replayed records. To drop the rows too, [clear the copy](#target-ownership). Do not share a state file between independent machines or put it inside a managed Markdown folder. Its parent directory must exist.

A checkpoint is saved after its rows commit, in a separate store. If the rows commit but the save fails, the copy reports that failure with the committed counts, and the next run replays from the last saved checkpoint: delivery is **at least once**. Append keeps replayed observations; deduplication reconciles them. Resumable full refresh is not implemented.

### Checkpoint stores

State belongs to the orchestration, not the destination, as in Airbyte, so any store works with any destination, including one that cannot hold state itself: the replication saves each checkpoint only after its stream's rows before it committed. `CheckpointStore.run(bindings, work)` owns that protocol for every incremental copy of a pass at once (the binding check per copy, the cloned input state, advancing only on a commit, `reset` and `clear`). A store supplies a session that holds every copy's lock for the whole pass and whose `save` is durable when it resolves.

| Store                                                            | Keeps state in                                                                                                                                                                                                                                    | Concurrency                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SQLiteCheckpointStore({ path })` from `elt-sqlite`              | A `checkpoints` table in its own file, owner-only (`0600`). Use it with SQLite and Markdown destinations. The file must differ from a SQLite destination file and must not sit inside a managed Markdown folder. Its parent directory must exist. | A lock per copy `id`, held through `@zukhruf/mutex`'s `SqliteStore` in a `<path>.locks` folder beside the file: different ids run in parallel, and a run that finds one id in use releases the ones it took and fails with "in use by another run". The kernel releases a lock when its process exits. Each save commits on its own, so no checkpoint transaction stays open while the load runs. |
| `PostgresCheckpointStore({ url, schema })` from `elt-postgresql` | `<schema>._elt_checkpoints` (`id`, `binding` and `state` as `JSON`, which keeps state that `JSONB` would refuse). It sits beside the data, so `DROP SCHEMA … CASCADE` resets both.                                                                | A session advisory lock per copy `id` on its own connection, taken in sorted order: different ids run in parallel, and a run that finds one id in use releases the ones it took and fails with "in use by another run". Each save autocommits, so no checkpoint transaction stays open while the load runs. The table is created in its own committed transaction under the writers' schema lock. |

### Snapshot streams

A source without a change feed can still load incrementally with `diffSnapshot(stream, records, state)`. The stream declares `sourceDefinedCursor`, and `emitsDeletes` when a key missing from a scan was deleted upstream ([forgetting upstreams](#forgetting-upstreams) leave it out); the source passes one complete scan and the previous state:

```ts
protected override async *extract(configuration, state) {
  yield* diffSnapshot(configuration.stream, this.scan(configuration.stream), state);
}
```

The state is `{ snapshot: { <primary key JSON>: <SHA-256 of the record> } }`. Each run emits new or changed records, a `DELETE` for every key the scan no longer contains, and the new snapshot as the only `STATE`. Unchanged records produce no writes. The first run (`null` state) loads everything and deletes nothing.

- **Replay:** if the checkpoint save fails after the data committed, the next run diffs against the older snapshot, re-applies the same upserts and deletions, and reaches the same rows.
- **Failures:** an empty scan deletes every row. The source must throw on a failed read and never yield an empty collection instead. A key repeated within one scan is rejected, so a source that reads overlapping windows deduplicates first.
- **Cost:** the source still reads everything each run; only destination writes shrink. The state holds one key and a 43-character fingerprint per row, so it grows with the stream.
- **Reset:** resetting the checkpoint makes the next run reload everything but forgets which rows exist, so rows deleted upstream meanwhile stay behind. Reset together with clearing the target, or run a full-refresh overwrite.

When the records come from inputs the source can fingerprint without reading them, such as files whose stat identifies their content, `diffGroupedSnapshot(stream, groups, state)` skips the reading too. Each group is `{ key, fingerprint, records() }`: one input, a fingerprint of it, and a function that reads its records. A group whose fingerprint equals the one saved for its key keeps its saved rows and `records()` is never called; every other group, and any group whose fingerprint is `null`, is read and diffed record by record. The state is `{ groups: { <group key>: { fingerprint, snapshot } } }`, with `snapshot` as above.

- **Deletions:** a key that no group produced this run, carried or read, is deleted, so a vanished input deletes its rows and a changed one deletes rows it no longer produces. The groups must still come from a complete listing: the source enumerates every input on every run and skips only the reading.
- **Fingerprints:** a fingerprint must change whenever the group's records could, including when the source's own parsing changes. A version constant in the fingerprint does that. A fingerprint that misses a change keeps stale rows without any error.
- **Moves:** a row that moves to another group is compared with its previous fingerprint wherever it was, so it loads only if it changed. A key produced twice in one run, including by a carried group, and a group key repeated in one run are rejected.
- **Airbyte:** the [file-based cursor](https://github.com/airbytehq/airbyte-python-cdk/blob/d5536bc78c261a5f7d89595cb811c8bad676e251/airbyte_cdk/sources/file_based/stream/cursor/default_file_based_cursor.py#L82-L111) also skips unchanged files, but by modification time alone, keeps at most 10,000 files before falling back to a time window, and never emits deletions. Groups keep every fingerprint, compare it for equality rather than recency, and delete from the complete listing.

#### Expiring upstreams

Some upstreams keep records only for a while and then drop them without any deletion, as macOS keeps activity for 28 days and Safari keeps history for its configured age. Without help, a snapshot diff would delete those rows too. A stream that declares `expiresBy`, the name of a non-null millisecond `date-time` property, keeps them: its source tells each diff that the read [covers](#partly-held-upstreams) only what vanished after the horizon the upstream keeps records from, `diffSnapshot(stream, records, state, { covers: expiredAfter(horizon) })`, and the same for `diffGroupedSnapshot`. A diff of such a stream without `covers` fails.

- **Expiry:** each snapshot entry also saves the record's `expiresBy` value (`[fingerprint, expiresBy]`), which `covers` receives as `{ key, expiresBy }`. A key that vanished with a value before the horizon expired: it leaves the snapshot with no `DELETE`, and its row stays loaded. A key that vanished at or after the horizon is deleted as usual, so a deletion the upstream makes within its retention still reaches the destination.
- **The horizon:** the source sets it on every read from the upstream's own retention rule, never from the oldest record it finds: a "clear all" leaves no old record, which would turn every deletion into an expiry. Erring toward an earlier horizon misses deletions of the oldest records; erring later deletes rows the upstream merely expired, so sources set it a margin inside the retention.
- **Returns:** a key that turns up again after it expired, such as an event another device synced late, loads as new.
- **Bounded state:** expired keys leave the state, so it grows with what the upstream keeps, not with everything ever loaded.
- **Rows outlive the upstream:** clearing the copy or a full-refresh overwrite loses every expired row for good, because no rerun can read it again. A reset keeps them, and so does a change of the stream's fields ([shape changes](#shape-changes)). Nothing marks a loaded row as expired.
- **Precedent:** [dlt's `delete-insert`](https://github.com/dlt-hub/dlt/blob/1.30.0/dlt/destinations/sql_jobs.py#L200-L234) and [`scd2` with a `merge_key`](https://github.com/dlt-hub/dlt/blob/1.30.0/dlt/destinations/sql_jobs.py#L969-L990) likewise retire only rows within what a load reloaded; Airbyte deletes only on change-data-capture markers, and its [refreshes guide](https://github.com/airbytehq/airbyte/blob/0eef98ff7f266392e6d1e1077e80d66971f2a378/docs/platform/operator-guides/refreshes.md#L36-L96) names a source that "does not retain all of its records" as the case where truncating loses data. Here the source scopes deletions by time instead, because it knows the upstream's retention.

#### Partly held upstreams

Some upstreams hold only part of their records and say which part, as the Slack app caches the stretches of each conversation it loaded and records their ranges. A message that vanished inside a range the cache still holds was deleted; one outside every range was only dropped from the cache. The source tells the diff which vanished records the read vouches for:

```ts
protected override async *extract(configuration, state, partition, scan) {
  // A vanished message is deleted only where the app still holds the history.
  yield* diffSnapshot(configuration.stream, this.scan(configuration.stream), state, {
    covers: ({ key }) => scan.holds(key.workspaceId, key.channelId, key.ts),
  });
}
```

- **What `covers` receives:** each key the last committed scan saw and this one did not, as the primary key's fields, with the saved `expiresBy` for an [expiring](#expiring-upstreams) stream. It returns whether that record was deleted.
- **Uncovered keys:** a key the read does not cover leaves the snapshot with no `DELETE`, and its row stays loaded; a key that turns up again loads as new. Without `covers`, a read covers every key.
- **Who decides:** only the source knows what its upstream still holds, so the rule is a per-read argument, never a stream declaration: what a cache holds changes with every read.
- **Rows outlive the upstream**, as for expired rows: clearing the copy or a full-refresh overwrite loses every uncovered row for good.
- **Precedent:** Airbyte deletes only on change-data-capture markers, and its Slack source never deletes; Fivetran's Slack connector re-reads all history to capture deletes, which a read that covers everything amounts to.

#### Re-read windows

Some reads ask for a window, and the next read asks for part of it again, as Search Console reads every day from the last settled one, because Google may still restate those days. Without help, the snapshot would hold every record the first read loaded, sixteen months of them, and a later read that starts after a day would take its rows as vanished. The source tells the diff which records the next read reads again:

```ts
// The next read starts at the last settled day.
yield *
  diffSnapshot(stream, rows, state, {
    keeps: (record) => String(record.date) >= nextStart,
  });
```

- **What stays:** only the records `keeps` accepts stay in the saved snapshot, so the state holds no more than the next read compares. A record left out cannot vanish from that read, so its row stays loaded and is never deleted.
- **What is deleted:** a kept record the next read no longer returns, such as a query Google stopped reporting for a re-read day, or every row of a day that comes back empty.
- **Who decides:** the source sets where its next read starts, from its own checkpoint, so `keeps` and that start come from the same value. Keeping fewer records than the next read covers leaves rows it stopped returning; keeping more deletes rows it never asked for.
- **Precedent:** Airbyte's Search Console source reads only final data and states that its ["syncs do not delete rows"](https://github.com/airbytehq/airbyte/blob/4bc984c55bafae1fdf1f09d9dcc62fbea0a98241/docs/integrations/sources/google-search-console.md#L246-L247); Fivetran re-syncs a seven-day rollback window without capturing deletes. [dlt's `delete-insert`](https://github.com/dlt-hub/dlt/blob/5084786a456038fab4b4e05f50492a718430d0a6/docs/website/docs/general-usage/merge-loading.md#L22-L29) with a merge key replaces each day a load brings at the destination, but a day that comes back empty brings no merge key and keeps its rows.

#### Forgetting upstreams

Some upstreams drop records for reasons they do not record, so nothing tells a deletion apart from the rest. Notification Center deletes a notification when its app withdraws it, the user clears it, a newer one replaces it or it expires, all with the same `DELETE`. A stream over such an upstream leaves out `emitsDeletes`: the diff then never emits a `DELETE`, and every row it loaded stays.

```ts
// Notification Center forgets notifications: no emitsDeletes, so a vanished
// one keeps its row. Its source diffs each scan as any snapshot stream does.
const notifications = new Stream({
  ...declaration,
  sourceDefinedCursor: true,
});
```

- **What changes:** only deletions. New and changed records load as in any snapshot stream, and an unchanged one writes nothing.
- **Bounded state:** a vanished key leaves the state, so it holds what the upstream keeps now; a key that turns up again loads as new.
- **No covers:** such a stream takes no `covers`, and `expiresBy` requires `emitsDeletes`: an expiring upstream deletes within its retention, a partly held one within what it holds, a forgetting one never.
- **Rows outlive the upstream**, as for expired rows: clearing the copy or a full-refresh overwrite loses them for good, while a reset or a change of the stream's fields keeps them. Nothing marks a loaded row as gone from the upstream.
- **Airbyte:** destination rows are deleted only "if your source supports emitting deleting records (e.g. an CDC database source)" ([incremental append + deduped](https://docs.airbyte.com/platform/using-airbyte/core-concepts/sync-modes/incremental-append-deduped)); an incremental stream without deletion support keeps every row it loaded. Here that is a declaration on the stream rather than a property of the source.

### Partitioned streams

One source can read a stream as several partitions, such as one per Search Console property or per account. The stream declares `partitionKey`, a subset of its `primaryKey`; the source lists the partitions from its configuration and receives each one in `extract`:

```ts
protected override partitions(stream) {
  return this.siteUrls.map(siteUrl => ({ siteUrl }));
}

protected override async *extract(configuration, state, partition) {
  // state is this partition's own checkpoint, or null the first time.
}
```

`Source.read` calls `extract` once per partition, in the listed order, and keeps each partition's state apart. The checkpoint is `{ partitions: [{ partition, state }] }`, owned by the library. Each time a partition checkpoints, the library emits the whole envelope, holding that partition's new state and every other listed partition's latest one, so each partition commits as it finishes:

- **New partition:** it receives `null` and starts from the source's normal beginning, for example a full history backfill, while the others resume.
- **Removed partition:** it leaves the next checkpoint; its rows stay loaded. Reading it again later starts it from `null`.
- **Identity:** the partition list is not part of the source identity or the checkpoint binding, so adding or removing a partition never invalidates the others' checkpoints.
- **Rows:** every record and every `DELETE` key must carry its partition's values; a row naming another partition, or none, fails that partition. The `partitionKey` fields are members of the stream's `primaryKey`, so a deduplicating copy's key always includes them.
- **Failures:** as in Airbyte, a failing partition does not stop the others. Its rows since its last checkpoint are discarded and it keeps its saved state, so the next run retries it from there; the other partitions commit and advance. The copy then reports the failed partitions, and the run fails naming each one. A failing partition is never skipped silently.
- **Full refresh:** partitions are read the same way without state, and an overwrite replaces the whole target with every listed partition.

Partitions are declared without I/O: `partitionKey` fields must be distinct non-null scalar members of the primary key, and the list must be non-empty with no repeats.

### Read context

A pass is one connection's read: one `Source.read(catalog, states)` over every stream the connection selected, as Airbyte's `read(config, catalog, state)`. `Pipeline.run()` makes one pass per connection. The source opens one context for the whole read, so related streams describe the same moment of the source; separate reads would let a join stream reference a row its parent stream never saw.

```ts
class ChatSource extends Source<ChatDatabase> {
  protected override open(streams) {
    return ChatDatabase.open(this.path); // AsyncDisposable, disposed when the read ends
  }

  protected override async *extract(configuration, state, partition, database) {
    // database is the read's context
  }
}
```

- **Contract:** every source implements `open(streams)`, receiving the streams the read covers. An upstream with a read transaction pins it (Messages; Notes; Contacts, once per account store). One without reads every selected stream up front in one change-free window and serves the streams from that snapshot (Calendar and Reminders, see [EventKit consistency](#eventkit-consistency)). A source whose streams need not agree returns an empty `AsyncDisposableStack` (Search Console).
- **Stream status:** each stream reads as `STARTED`, its messages, then `ENDED`; a partition or stream that failed adds `FAILED` with its error. Only `Source.read` creates a `StreamStatus`; one yielded by `extract` fails its stream with a `TypeError`, as does a message naming any stream but the one being extracted, so a stream can never write into a sibling's target.
- **Interleaving:** `protected concurrency` (default 1) sets how many streams read at once; their messages interleave. A stream is asked for its next message only after the consumer took its last one, so a record's file stays valid until the consumer advances. A source that raises it reads its context from several extracts together. Partitions of one stream always read one after another.
- **Lifetime:** the context opens when the read starts and closes when it ends, including when it fails. A watch reads once per pass and holds nothing while idle, since a long read can block the upstream's own maintenance.
- **Failures:** a context that cannot open (a denied permission, a missing store) fails every copy of that pass; `PipelineError.cause` is the error. Other connections' passes are unaffected.
- **One copy per stream:** a connection copies each stream once (`Connection <name> copies each stream once`), as Airbyte's configured catalog lists each stream once. To load one stream into two targets, use two connections.

#### EventKit consistency

EventKit has no read transaction, so Calendar and Reminders contexts read optimistically: a watcher subscribes to `EKEventStoreChangedNotification`, every selected stream is read, and the reads repeat if a change arrived during them or within 250 ms after, the notification's delivery delay. Five disturbed attempts in a row raise `EventKitChangingError`. Each attempt is one `eventkit` helper process that reads every selected stream. The snapshot holds the selected streams' records in memory for the run. Measured on 2026-09-29 (macOS 27): a full Calendar read from 2000 to 2027 (10,956 events, about 110,000 ICS parameter rows) took about 6 s, and Reminders about 0.1 s.

### Apple Notes behavior

The source reads Notes' own Core Data store, `~/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite`, read-only under Full Disk Access through its SDK, `@workspace/sdk-apple-notes`; Notes does not need to be open. Each run reads every selected stream inside one SQLite read transaction, so notes, attachments and folders come from the same moment. Note bodies are gzipped protobuf documents and tables are gzipped CRDT documents; both are decoded in-process.

| Stream              | Key    | Contents                                                                                                                                                                                                                                                                                                                                                          |
| ------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accounts`          | `[id]` | Name and Notes' numeric account `type`.                                                                                                                                                                                                                                                                                                                           |
| `folders`           | `[id]` | Account, parent folder (nested folders), name, `type` (`1` is Recently Deleted), a smart folder's query, and whether it is shared.                                                                                                                                                                                                                                |
| `notes`             | `[id]` | Folder, account, title, plain `text`, `markdown`, created and modified times, `pinned`, Notes' own `hasChecklist` and `checklistInProgress` flags, `locked`, `shared`.                                                                                                                                                                                            |
| `inlineAttachments` | `[id]` | Tags, mentions, links to other notes and calculation results as Notes stores them: `type` is Notes' identifier (for example `com.apple.notes.inlinetextattachment.hashtag`), `text` is what the note shows (`#travel`), and `target` what it points at: a tag's normalized name (`TRAVEL`), or for a link to another note that note's `applenotes:note/<id>` URL. |
| `attachments`       | `[id]` | Type identifier, title, file name, URL, Notes' summary, recognized text (`ocrText`, `handwritingText`), image labels, audio `transcript`, size, duration, dimensions, location, times, and `availableLocally`. Supports file reads.                                                                                                                               |

A note's content lives in one place, its `markdown`: checklists render as `- [x]` items and tables as Markdown tables where they sit in the note. They are not repeated as separate streams.

`markdown` renders Notes' paragraph styles and runs: Title, Heading and Subheading as `#`, `##` and `###`; bullet, dashed, numbered and checklist lists with their indentation; Monospaced as fenced code; block quotes; bold, italic, strikethrough and links. Underline, fonts and colors have no Markdown form and are dropped. A table is rendered in place, an inline tag or mention as its text, a link to another note as `[title](<applenotes:note/…>)`, and a file as `[name](attachment:<id>)` naming its `attachments` row. `text` is the note's visible text with inline tags and mentions kept and file placeholders removed.

All streams are [snapshot streams](#snapshot-streams): incremental copies select no `cursorField` and use `append_dedup` keyed by the stream's key. Each run reads the whole store, writes only new and changed records, and deletes records that disappeared, including rows Notes marks for deletion. Reading is cheap: the store is local SQLite, so a run over thousands of notes takes milliseconds before decoding.

Notes in Recently Deleted are notes in that folder, so they remain in the export until permanently deleted. Notes that Notes has listed but not yet downloaded from iCloud have no folder, title or dates; they are left out until they arrive. A locked note keeps its title, dates and flags; its text and Markdown stay out, and its attachments keep only their type, name, size and times.

Only Notes syncs iCloud notes on the Mac. While Notes is closed, the store holds what Notes last synced: edits made on other devices reach it the next time Notes runs, which a [Notes watch](#watching-for-changes) arranges by launching Notes hidden.

The store's layout changes between macOS releases. The SDK reads the macOS 26 layout and checks every column it uses when it opens the store; a store without one fails with `NotesSchemaError` naming the missing columns rather than loading misplaced fields. A store that cannot be opened (missing, or no Full Disk Access) fails with `NotesUnavailableError`.

## Watching for changes

Use the same configured pipeline for continuous synchronization:

```ts
const controller = new AbortController();

for await (const { connection, outcomes } of pipeline.watch({
  signal: controller.signal,
})) {
  // This pass's copies have already extracted, loaded, and saved their checkpoints.
}

// Call controller.abort() from your app's stop/shutdown handler.
```

Watching preflights every connection, then each connection watches its own source: it subscribes before the initial synchronization and runs a pass over the copies whose streams receive notifications. It uses the existing copy modes: incremental Notes and Calendar copies stay incremental, and full-refresh copies stay full refresh. Notifications do not provide records or turn a full-refresh copy into an incremental one. `run()` remains a single execution; the Apple CLI and plugin use only `run()`.

The source owns change detection:

- **Calendar and Reminders:** a persistent `eventkit watch` helper process subscribes to native `EKEventStoreChangedNotification` notifications. These invalidate all selected streams because EventKit does not identify individual changes. The notification covers the whole event store, so a Calendar edit also re-extracts a Reminders watch, and a Reminders edit also re-extracts a Calendar watch. The existing EventKit permission requirements apply. Full-refresh overwrite reconciles deletions on the next successful pass.
- **Notes:** the watcher opens its own read-only connection to `NoteStore.sqlite` and checks `PRAGMA data_version` every second; it changes with every commit another connection makes, so each save Notes commits invalidates every selected stream. Filesystem notifications are not used: Notes keeps the store and its WAL open, and FSEvents reports a write only when the file closes, which verification showed arrives when Notes quits. Because only Notes syncs iCloud notes, the watch keeps Notes running: it launches Notes hidden and in the background (`open -g -j`) when it starts and, every 30 seconds, again if Notes has stopped. It cannot tell your quit from macOS closing a hidden Notes, which happens when the system frees disk space (seen twice on a 99% full disk, within minutes of a hidden launch), so it relaunches in both cases. A running Notes is left as it is. Watching needs the same Full Disk Access as reading.

A connection's passes are serial; passes of different connections run side by side, and each waits only on the consumer, so a slow source never holds back another. Notifications received during extraction or while the caller handles a result are coalesced into that connection's pending set of streams, so they cause a subsequent pass without an unbounded queue of sync jobs. A connection's first invalidation must cover every stream it selected. Each pass yields a `Pass`, `{ connection, outcomes }`, once its loading and checkpoint persistence finished; each outcome carries the committed `count` and `deleted` (accepted observations, including deduplication no-ops and absent keys) and its `failures`, empty when it loaded completely. As Airbyte keeps a connection's schedule after a failed sync, a pass that did not load completely does not end the watch: the caller sees its failures, the failed partitions keep their checkpoints, and the next invalidation of that stream retries them.

A connection whose watcher fails stops alone, and is recorded as a failed attempt when the pipeline has a [sync history](#sync-history); the other connections keep watching. Once every connection has stopped, or the signal aborts, the stopped connections' errors are thrown together as an `AggregateError` whose message joins `Connection <name>: <message>` entries. No retries between invalidations, periodic reconciliation or automatic disabling are added.

Aborting stops native observation, lets each in-flight pass finish and yield its result, and prevents another pass. Breaking the loop also closes the watchers. A new watch session subscribes and performs an initial pass again, using the saved checkpoints. Notifications themselves are not durable, and the source's existing snapshot/cursor limitations still apply.

Custom sources declare a `catalog` and implement `observe({ streams, signal }): AsyncIterable<readonly Stream[]>` and `coverage(stream): ExtractionCoverage`, the source's own statement of what a pass over that stream asks the upstream for (see [sync history](#sync-history)). The base `Source` owns `discover()`, `validate()`, and `watch()`: before extracting or observing, it rejects any stream that is not the same object as its catalog's stream of that name. A stream's schema shapes the destination, so a lookalike stream with a matching name is refused. Add source-specific selection rules, such as a required cursor field, by overriding `validateExtraction()`. In `observe()`, establish observation before yielding all selected streams once; then emit the affected selected streams until cancellation. The connection keeps consuming these invalidations while it loads records. Close native resources when aborted or when the iterator is closed; errors must propagate. `Stream` remains immutable metadata, and loading continues through `Source.read`, `Copy`, and the destination writers.

Automated verification covers actual filesystem events in temporary storage, the EventKit helper's watch subscription and its shutdown on abort, and destination/checkpoint visibility before results are yielded. The native filesystem test requires an environment that permits filesystem notifications; this host's sandbox reports `EMFILE` even for a single temporary-directory watcher, while the same probe succeeds outside it.

Live verification on **2026-09-22**, using **macOS 26.6.2 and Node.js 26.8.1**, exercised the existing sources, `Pipeline.watch()`, `Copy`, and temporary SQLite destinations without mocking notifications or extraction. Calendar and Reminders each completed four observed passes: initial sync, creation, update, and deletion. Their mutations were real EventKit writes from separate OSA processes. SQLite assertions ran after the watcher yielded completed loads.

| Source stream         | Live assertions                                                                                                                                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Calendar `events`     | A uniquely labeled event appeared, its changed title and start time reached SQLite, and deleting it removed the exported row. The fixed occurrence window was `2026-09-22T00:00:00.000Z` to `2026-09-23T00:00:00.000Z`. |
| Reminders `reminders` | A uniquely labeled reminder appeared, its changed title and completed status reached SQLite, and deleting it removed the exported row.                                                                                  |

Watchers were closed after verification. The Calendar test event, temporary Reminders list, and temporary databases were removed. EventKit cleanup was checked through fresh native reads. Existing user records were not modified. This live pass covered the primary streams and SQLite; Calendar/Reminders GUI edits, other streams, and Markdown were not exercised live.

**Notes live verification** on **2026-09-25**, macOS 26.6.2 and Node.js 26.8.1, against the real store with Notes closed, the process holding Full Disk Access:

- Without Full Disk Access the group container cannot even be listed (`EPERM`); with it, the store opens read-only while Notes is closed or running.
- Only Notes writes note and iCloud-sync data: every persistent-history transaction on note, folder, account and server-change-token entities came from `com.apple.Notes`. With Notes closed the store does not change; an edit made on an iPhone reached the store only after Notes was launched hidden, and the watch loaded it within a second of Notes committing it.
- Recursive filesystem notifications on the container did not report Notes' WAL writes while Notes ran; the event arrived when Notes quit. Per-commit `data_version` polling saw every commit.
- A hidden launch (`open -g -j`) left the frontmost app in front and put no Notes window on screen, and Notes synced on launch. macOS closed the hidden Notes twice within minutes to free disk space on a 99% full disk; the watch relaunched it hidden on its next check.
- The exporter loaded every stream; a second run with no changes wrote nothing. Temporary notes made for the probe (formatted text, a table, and PNG, PDF, M4A, TXT and ZIP attachments) matched what was created: headings and emphasis, lists, the table's cells, each file's bytes, and text parsed from the PDF and TXT.
- Ten of the store's note rows were placeholders for notes not yet downloaded from iCloud (no folder, title or dates); the export leaves them out and then equals what Notes shows.
- A Markdown file imported into Notes produced real Title, Heading, Subheading, checklist (one done, one open), Monospaced, block quote and table formatting; the export rendered each as its Markdown form and set `hasChecklist` and `checklistInProgress`. A hashtag typed into a note became an `inlineAttachments` row (`#macEltTag`, target `MACELTTAG`) and appeared in the note's `text` and `markdown`. The watch loaded each edit within seconds of Notes saving it.
- The probe notes and folders were deleted afterwards and purged from Recently Deleted; the store then marked them for deletion.

- A link to another note, made through Notes' `>>` picker, became an `inlineAttachments` row of type `com.apple.notes.inlinetextattachment.link` whose target is the linked note's `applenotes:note/<id>` URL, and rendered in `markdown` as a Markdown link to it. A pasted web address became a link in the text.

Not verified live, each for a stated reason:

- **Audio recordings and transcripts, locked notes, rich web-link previews:** Notes keeps Record Audio, Lock Note and Share disabled unless a person has the note focused, so scripts cannot start them. Locking also needs the Notes password.
- **Scans and sketches:** Notes on the Mac inserts them only from an iPhone or iPad camera or pencil.
- **Mentions:** they exist only in a note shared with another iCloud user.
- **Locations:** added only through the Maps share sheet.

Checklists, tags, tables and a locked note were also read from Apple-made macOS 26 sample stores. The unverified kinds are read as the published format describes them; to verify one, create it in a Notes folder and import Notes with `apple-cli`.

## Attachment files and document parsing

```ts
import { LocalFiles } from '@workspace/elt';
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

This stores the selected source metadata, parsed `content` and an `attachmentRef` as TEXT. The original attachment ID and containing note ID remain available for joins. `LocalFiles` stores the original bytes and returns their absolute local path. SQLite and Postgres receive only that ordinary text value: they do not construct paths or write attachment files. The Apple hosts store only the `attachmentRef` for every stream with files, in each import's `files` folder; they do not parse file text.

Storage is selected on each file reference with `.store(files)`, independently of the connection and destination. Two fields can use different stores, and copies can share one store without sharing file ownership. Constructing a store or declaring a field performs no I/O. A stored reference and parsed text must be separate fields; applying `.parse()` to a stored-file field is refused.

`LocalFiles` resolves the chosen directory at construction. It streams each file in chunks of at most 4 MiB into a temporary file, syncs it, then publishes it atomically. Files live in `.elt-files/<scope hash>/<content hash><extension>` beneath that directory. The scope identifies the destination target, copy writer and field; the content hash makes repeated saves stable without overwriting an existing reference. A safe source extension is preserved; the original filename stays in source metadata. Empty files are real zero-byte files. Unavailable source files produce null references.

The shared transfer saves files before applying records and commits database rows before removing obsolete files. It asks each destination for the references its committed rows actually retain, so a cursor-rejected update cannot delete the winning attachment. Append retains the files of every retained observation; replacement, deletion, empty overwrite and `Copy.clear()` remove files only when this scope no longer references them. Cleanup runs while the target's writer lock is held. Source failures discard pending rows and reconcile against the retained rows.

Files and database rows do not share a transaction. A failed save prevents its rows and checkpoint from advancing. A cleanup failure after a database commit preserves that committed data but prevents the checkpoint from advancing; replay is safe. A failed database write or interrupted run can leave unreferenced files; the next run reconciles them before extraction using the current committed references. Missing referenced files, non-file references and invalid managed directories fail explicitly. Keep these generated files intact until clearing and rebuilding their copy.

For another storage backend, implement the exported `FileStorage` contract: a stable `identity`, a `reference` sentence telling readers what a saved reference is (Postgres writes it as the reference column's comment), `save(scope, FileContent)` returning a durable, immutable, repeatable text reference, and `retain(scope, references)` removing only that scope's unreferenced objects. Identity participates in the copy's checkpoint binding. The transfer treats references as opaque strings, so a future S3 store can return its own reference format without changing database destinations. Only `LocalFiles` is supplied today. Reconciliation scans retained references and the scoped directory at each commit; it does not maintain a separate object index.

The columns declare what to extract. `Copy` collects those declarations; `Source.read()` performs parsing and exposes original files as a `FileContent`, valid until its record is consumed. The shared transfer resolves stored-file declarations before sending records to the destination. Omitting a stored reference avoids retaining the original file; omitting all file-derived columns avoids exporting files altogether.

### Explicit database byte storage

Use `c.blob('bytes').from(notes.attachments.file)` when the database should own the original bytes instead. This is independent of `.store(files)` and remains available for both SQL destinations. The file and row then commit together in the database.

SQLite stores an original file in chunks, because one BLOB is capped at 1,000,000,000 bytes (`SQLITE_MAX_LENGTH` in Node's build) and a whole-file value would sit in memory. The `bytes` column holds an INTEGER file id, and a per-column `_elt_files_<hash>` table holds `(file, n, bytes)` rows of up to 4 MiB, `n` counting from 0. The hash is the first 40 hex characters of SHA-256 over `JSON.stringify([table, column])`, with both names in ASCII lower case, so table `a_b` with column `c` and table `a` with column `b_c` keep their chunks apart. The column's description names its chunk table. An empty file has one empty chunk. Triggers remove a row's chunks in the same transaction whenever the row is deleted, overwritten or replaced, and a record that a deduplication guard rejects stores none. Read a file back in order, with the chunk table the description names:

```sql
SELECT c.bytes FROM "_elt_files_<hash>" AS c
WHERE c.file = (SELECT bytes FROM attachments WHERE id = ?)
ORDER BY c.n;
```

Verified on 2026-09-24 (macOS 26.6.2, Node.js 26.8.1): a 1.5 GB file loaded as 358 chunks in 3.3 s with a peak RSS of 137 MiB, and the reassembled chunks matched the file's SHA-256.

Postgres supports the same `text().from(file).parse(parser)` and `blob().from(file)` declarations. Parsed content is TEXT. An original file's column holds a UUID; its bytes live in a per-column `_elt_files_<hash>` table in the destination schema, with `(file UUID, n BIGINT, bytes BYTEA)` chunks of up to 4 MiB. The hash is the first 40 hex characters of SHA-256 over `JSON.stringify([tableName, columnName])`. Join the file UUID and order by `n` to read the original. Empty files have one empty chunk; unavailable files have a null reference. The loader removes unreferenced chunks when a stage commits or is discarded, and when it reopens after a crash; clearing a copy removes its files too. A plain `blob()` column without `.from(file)` stores an inline BYTEA value.

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

A bare table still infers the discovered metadata schema. To include all metadata alongside file-derived columns, spread `SQLiteColumns.fromSchema(notes.attachments.jsonSchema)` into the columns array. A plain `c.blob('bytes')` reads a record's existing `bytes` field into an inline BLOB. `.from(file)` selects the original source file; `.parse(parser)` requests its text representation. Original bytes require a BLOB column; parsed text and stored-file references require TEXT. The existing `.notNull()` and `.primaryKey()` constraints apply to these fields. Incompatible types, another stream's file reference, and fields colliding with source metadata or `loaded_at` fail before extraction.

`notes.attachments.file` is an immutable source reference, not a path. Other Notes streams reject file access. All declarations remain immutable and perform no I/O; the discovered source schema is never rewritten to describe destination fields. A file can supply multiple named representations in one copy. Each record is exported once; requests using the same parser instance share one parse, and original-byte requests share one read. Separate copies retain separate extraction and checkpoint progress.

Markdown targets use the same destination-independent `FileRead` declaration, alongside their existing metadata rendering:

```ts
import { FileRead } from '@workspace/elt';

new Copy(
  notes.attachments,
  markdown.folder('attachments', {
    fields: [
      new FileRead(
        'content',
        notes.attachments.file,
        new MacOSDocumentParser(),
      ),
    ],
  }),
);
```

Markdown accepts parsed text and stored-reference fields, such as `new FileRead('attachmentRef', notes.attachments.file.store(files))`, and rejects binary requests before I/O. Its `file()` target supports the same options as `folder()`.

This follows Airbyte's source-side parser and staged-file concepts: its [file parser Strategy](https://github.com/airbytehq/airbyte-python-cdk/blob/f77450f74def59598cda8e1e9a4e975031710c18/airbyte_cdk/sources/file_based/file_types/file_type_parser.py) interprets files, while [file transfer](https://docs.airbyte.com/platform/using-airbyte/sync-files-and-records) moves original content with metadata. Our parser emits plain text, not Airbyte's Markdown conversion, and we do not claim its complete format/OCR support or wire compatibility.

`MacOSDocumentParser` uses native PDFKit for PDFs with a text layer and native `textutil` for TXT, Markdown, RTF, HTML, DOC, DOCX, ODT, and WordML. It selects the format from the filename extension, preserves text/Markdown content, and strips rich formatting when converting other formats to plain text. HTML conversion does not load external resources. Images (JPEG, PNG, GIF, HEIC/HEIF, TIFF, BMP, ICO, WebP) go through Vision's accurate text recognition, one line per observation. ImageIO checks native dimensions first; images narrower or shorter than three pixels return null because Vision crashes or rejects these inputs. Voice recordings are not transcribed: macOS grants Speech Recognition only to an app bundle that declares why it asks, which neither `node` nor `osascript` is. vCards, including Messages' `.loc.vcf` locations, load as their text. A file without a known extension is identified by its leading bytes. Audio, video, unknown formats, locked PDFs, PDFs without a text layer and images without recognizable text parse to `null`, so the field loads as null and the copy continues. A file that cannot be read (a PDF that cannot be opened, an image Vision cannot decode, a `textutil` error) fails the copy. The parser's identity is `macos-document-v3`. PDF parsing uses the existing OSA command's 64 MiB output buffer and 120-second timeout. Text conversion uses Node's native `execFile` defaults (1 MiB output limit and no timeout).

Notes hands over the original file from its store, never a staged copy: `<NoteStore.sqlite directory>/Accounts/<account>/Media/<media>/[<generation>/]<filename>`, from the attachment's media row. An attachment has no file when its note is locked or it has no media row or filename (tables, links, sketches without media); a path that is not on disk (an iCloud file Notes has not downloaded) sets `availableLocally` to false. In each case the metadata loads and the file fields load as null. We never treat an attachment's URL as a download URL or invent a missing filename.

`Source.read()` is the shared template method. Source implementations provide protected `extract(configuration, state, partition, context)`, yielding metadata, optional file paths, and state. The source resolves `configuration.fileReads` into parsed text or a `FileContent` before yielding records to the destination. A path must stay readable until the consumer advances past its record: a staged copy the source cleans up afterwards, or the original file when copying it would be costly (Notes and Messages hand over their attachment files). Destinations reject any leaked path.

Extend `DocumentParser` with `parse(path): Promise<string | null>` for another parsing implementation. Return `null` when the file has no text the parser can represent, and throw only when reading it failed. Give it a stable identity that includes its version and relevant configuration; keep the implementation/configuration immutable and parse without modifying the file. A parser does not depend on Notes or SQLite. Parser identity participates in the copy's checkpoint binding; changing it requires a new copy ID or explicit checkpoint reset. Source keys and cursors remain metadata fields, and a checkpoint is still acknowledged only after the rows before it commit.

The loaded `content` can be queried with normal SQL or indexed with SQLite FTS5 in the consuming application. Parsing does not create a search index. No query API or general transformation step is part of this library.

## Connectors and their hosts

Each Apple source is an island package in `packages/sources/apple/<name>` (`source-apple-<name>`) with its readers and tests; the readers several sources share are in `source-apple-macos`, and EventKit access with its Swift helper in `sdk-apple-eventkit` (`packages/sdks/apple/eventkit`). The Apple connectors live in `packages/connectors/apple`, one package each (`connector-apple-<name>`) that imports its source package. Its `package.json` is the manifest: `"type": "module"`, an `exports` string naming the entry point, and a `contextCompiler` field with the connector's `name` and `title`. The entry's default export is the connector's `AppleConnector` class (`connector-apple-connector`), which takes its name and title from the manifest and declares what the connector can be narrowed by, its permission guidance and how it loads. `Connectors` in `connector-apple-manifest` reads the folders under the roots a host gives it, in name order, skips any whose `package.json` declares no connector, loads each entry and creates its connector with the host's `AppleHost`, which names the app macOS grants access to and may offer a Google session; a connector that cannot be read or loaded is reported with its error while the others load. Both hosts load their connectors that way: the CLI from `packages/connectors/apple`, whose packages it depends on, the plugin from the connector folders bundled beside its server, and both then from the user's own folder, `~/Library/Application Support/Context Compiler/Connectors`, where a connector is added without a release. A user's connector is TypeScript that Node runs as written: its entry is a `.ts` file, named by a `package.json` beside it, using only syntax Node can strip (no enums or parameter properties), and every stream and field it declares carries a JSON Schema `description` for its reader view. It imports `@workspace/elt`, `@workspace/connector-apple-connector/apple-connector` and `@workspace/connector-apple-connector/choice` from its host, as the built-in connectors do: `provideHostModules` registers a resolve hook that maps those specifiers to the host's own copies (the CLI's workspace modules; the plugin's `server/modules`, which re-export its shared chunks), so its classes pass the host's checks. The plugin adds the connectors that could not load to every chat's Apple status; the CLI writes them to stderr. The plugin discovers its connectors again before every tool call and import pass, so a connector added or edited while a chat is open is used without a restart; an edited entry loads again because its import URL carries the file's modification time, while files it imports load once. Because Codex keeps a chat's tool list as it began, `apple_options` and `apple_configure` take the connector as a string checked when they run, not an enum. A selected connector that is not loaded is reported, not thrown on: its status says how to restore or disconnect it, the plugin keeps its selection unchanged through other changes (and refuses to change it), and the CLI's `sync` records the failure and still loads the other connectors. `$add-apple-connector` is the plugin skill that tells the agent how to write one. Both load each selected connector into SQLite imports of their own:

- `apps/apple/cli` (`npx nx run apple-cli:start -- <command>`) imports the connectors a terminal user selects into `outputs/cli`. `sync` runs one pass of each selected connector; run it again to refresh. Its Calendar import signs in to Google for Drive and Gmail attachments, so `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` must be set.
- `apps/apple/plugin`, bundled by `npx nx run apple-plugin:bundle` into `plugins/apple/server` (`main.mjs`, a folder per built-in connector beside it, and the chunks they share, so every connector runs on the server's own `elt` and `AppleConnector`; build output, ignored on main and published with the plugin to the `release` branch Codex installs from), is the Codex plugin's MCP server: one server per Mac imports every selected connector once while Codex is open, and does not refresh an imported connector. The plugin's hooks call its `apple_context` tool to give each chat the Apple status when the chat starts and whenever it changes. Codex keeps an older chat's server running after an upgrade but deletes that version's folder, so that server stops importing and tells the chat to open a new one. Its Calendar keeps remote attachments as links.

Each import holds one `data.sqlite` with `raw_<stream>` tables read through `<snake_stream>` views, its sync history and `catalog` views, `checkpoints.sqlite`, and a `files` folder.

Both hosts keep their selection in `settings.sqlite` through `Settings` (`@workspace/settings`) and run each import the same way, through `AppleConnector.import(settings, selection, history)`. One process at a time runs a pass of an import, holding `SQLitePasses` (`elt-sqlite`) on its `data.sqlite`: an import another process is loading is skipped, which the CLI's `sync` reports and counts as not synced, and the plugin leaves to the next start or selection change. Status comes from `SQLitePasses.status()`, which reports a pass recorded as running while no process runs it as `interrupted`, as after a killed sync. Removing a connector, from the CLI's `setup`, another chat or the Settings page, saves the selection first, so readers stop seeing it at once, and removes its import unless a pass is still loading it. That pass checks the selection about once a second, through `PRAGMA data_version` on `settings.sqlite`, stops at its next message once its connector is gone, and then removes its import; the CLI reports it as removed without failing the sync.

A connector's presets are SQL files in a `presets` folder beside its manifest, built-in or the user's alike. `presets/<view>.sql` holds one `CREATE TEMP VIEW <view>` over the connector's views, after `-- <view>: …` and `-- <column>: …` comment lines that describe the view and each column in order; Mail's `mail_messages` is one row per message with its sender, recipients, subject, Message-ID, body and attachments. A preset is the source's data in a shape readers ask for, not the answer to one question, and nothing stores it: a reader loads it for one connection, so the import is unchanged and `catalog` does not list it. `AppleConnector.presets()` lists the folder whenever it is asked, so a preset added to a user's connector is offered without a restart. The plugin's bundle copies each built-in connector's `presets` beside its entry; the Apple status names the folder and its presets under each loaded connector, and the query-apple skill loads one with `sqlite3 -readonly -cmd '.read "<file>"'`. The CLI's `query` loads every preset of the connector before the statement, and `--tables` lists them. `mail_messages` leaves out `attachmentRef`, which exists only when an import copies attachments; it is read from `attachments` on `messageId` and `partId`.

Calendar's coverage declares its configured window for event-derived streams, the overlap interval `[startAt, endAt)`, even when no event matches, and a listing without a date filter for accounts and calendars; ICS may describe a recurring series beyond the selected occurrences. Activity declares each stream's maximum age, past which macOS drops records while their rows stay. Every other Apple source shares `localAppleStoreCoverage`: the whole accessible local store, without a date filter, which cannot promise complete cloud history or retrievable attachment bytes.

`apps/google/src/connectors.ts` default-exports a list of `{ name, run }` entries that `main.ts` calls in order. Each `run()` owns its source configuration, credentials, pipeline, and post-load work. Search Console's builds a `Pipeline` with one `google-search-console` connection and a `PostgresSyncHistory`, runs it, and publishes its content marts after complete or partial loads once every raw table exists. Its coverage lives in `SearchConsoleSource.coverage(stream)`.

Each application records every pass and its declared extraction coverage beside the data it loads: the Apple hosts with `SQLiteSyncHistory` in each import's `data.sqlite`, Google with `PostgresSyncHistory` in the warehouse. `Pipeline` already includes failed streams and partitions in its errors. Connector-specific code that handles a partial failure, such as Google's marts publication, also sets exit status 1. Apple and Google stay separate apps until their later convergence.

## Execution and failures

`Pipeline({ connections, history? })` is the orchestrator. `run()` and `watch()` validate every declaration of every connection before any read: distinct connection names, copy IDs distinct across the pipeline, each connection's copies (unknown streams, a stream copied twice, unsupported combinations, invalid schema declarations, missing keys/cursors/IDs/state store), and [target ownership](#target-ownership) across connections. An invalid connection stops the whole pipeline without extraction or storage creation and, when a history is given, is recorded as a failed attempt for that connection. Preflight uses metadata; storage permissions, existing constraints and record values are checked during execution.

`run()` then makes one pass per connection, all side by side, so a slow source never holds back another. Each pass locks every incremental copy's checkpoint, opens one load on the destination, and prepares every target before reading anything: a copy whose target is refused (another writer's, or a reader view the load did not make) fails and reads nothing. Preparing publishes nothing; a target appears no later than its stream's first commit. One read then covers the remaining copies. As in Airbyte, every copy runs even when another fails, and every connection's pass runs even when another's fails. Each stream stages its operations apart from the others and commits them at its own checkpoints, so an incremental copy that fails keeps what it committed and publishes nothing it staged since; a full refresh commits once, when its stream ends, so a failure keeps the previous target. Empty overwrite clears it; empty append preserves existing records. There is no pipeline-wide rollback.

Verified live on 2026-09-26 (macOS 26.6.2) with the Apple exporter run twice against real stores: the first run loaded every stream (Messages 12,573 messages, Calendar 10,941 events) in 203 s; the second, 168 s, wrote nothing for Notes, Messages, Contacts and Reminders, and for Calendar only 2 events (with 1 alarm and 2 recurrence rules) that had just entered its one-year window, and 1 account EventKit listed for the first time. A run killed mid-write left a hot journal that SQLite rolled back on the next open; nothing it staged was published. The Search Console exporter completed every stream into the Postgres warehouse the same day.

When any copy is incomplete or any pass could not run, `run()` throws one `PipelineError` once every pass ends:

```ts
import { PipelineError } from '@workspace/elt';

try {
  await pipeline.run(); // [{ copy, count, deleted }] when every copy completed.
} catch (error) {
  if (!(error instanceof PipelineError)) throw error; // Preflight errors are direct.
  // error.results contains committed counts and stream/partition failures.
  // error.cause is the first failure.
  process.exitCode = 1;
}
```

`PipelineError` is an `AggregateError`: `errors` holds every failure, `results` holds every copy's committed `count` and `deleted` beside its `failures` (each with its `partition`, `error` and [`failureType`](#sync-history)), in connection order then copy order. A pass that could not run, such as one whose sync history could not be written, adds its error with the message prefixed `Connection <name>: `. A failure after rows committed, such as a checkpoint that could not be saved or a cleanup error after publication, is reported the same way with the committed counts; it does not imply rollback. A count of zero also covers a committed empty input.

`run({ signal })` stops a run on request, as Airbyte cancels a sync. Once the signal aborts, each pass applies no further message: every copy still reading drops what it staged since its last commit, keeps what it committed and the checkpoints saved with it, and ends `cancelled`; a copy that already ended keeps its outcome. The [sync history](#sync-history) records the pass as `cancelled` with the signal's reason as its error, and then `run()` rejects with `signal.reason`, as `fetch` does. `Source.read(catalog, states, signal)` passes the signal to each `extract` as its last argument, so a source waiting on its upstream can stop at once; one that ignores it stops at its next message.

Declarations are frozen and reusable. `Destination.createWriter(configuration, target)` selects a storage-specific strategy without I/O; `Destination.load()` opens the pass's one hold on storage, and `load.prepare(configuration, target, { writer, reloading })` gives each stream its `Stage` (`apply`, `commit`, `discard`; `fresh`, true when the target holds none of the copy's earlier rows, so the copy reads from no checkpoint; `reloading`, true while commits go to a hidden target; and `complete`, which puts that hidden target in the target's place once the stream ends without a failure). Every destination decides with `reloadMode` whether to load into the target, create it, evolve a stored target the stream no longer fits ([shape changes](#shape-changes)), open a reload for an overwrite whose stored target no longer fits, or continue the reload the copy's last run left open; a whole-stream `RESET` also opens one. Destinations own connections, files, and publication. `Copy`/`Pipeline` contain no SQL/filesystem loading branches. `Source.identity` and `Destination.location(target)` provide stable checkpoint bindings, and a stored file's scope is the target's location, the copy's writer and the file field; custom implementations must distinguish different source instances and stored objects.

SQLite holds a native writer lock for the whole pass in a `<database path>.writer-lock` sidecar containing no records. It survives individual commits and releases on handle closure or process exit; readers of the destination are unaffected. As in Postgres, no transaction stays open between commits: `prepare` only refuses (another writer's target, a reader view not its own, stored rows a deduplicating load cannot keep) and stages, and each commit is one write transaction, the first of which also creates the table, its mode's index, its reader view, its descriptions and its owner. Other writers to the file wait only for a commit, and a stream that fails before its first commit leaves nothing. Each stream stages its operations in a connection-private `TEMP` table: another stream's commit never publishes them and a crash leaves nothing behind. A commit merges one stream's staged operations into its table, with the result of applying them one at a time: a staged `DELETE` removes its key, only records after a key's last `DELETE` count, `replace` keeps the last and `cursor_newer` the first with the greatest cursor. Original files stream into a connection-private `TEMP` chunk table and reach the store in the commit of their rows; chunks no row references are deleted after each merge, and a clear empties the store. A file column the target drops takes its chunk table with it when the table evolves or a reload replaces it. `:memory:` is allowed only for full refresh; the run's database disappears when its handle closes, so it cannot safely retain incremental progress.

### Sync history

As Airbyte's platform keeps each connection's jobs and attempts apart from any connector, the orchestrator records every pass in a `SyncHistory`, exported from `elt`. Like a `CheckpointStore`, it belongs to the orchestration: pass it as `Pipeline({ connections, history })`.

```ts
import {
  PostgresCheckpointStore,
  PostgresDestination,
  PostgresSyncHistory,
} from '@workspace/elt-postgresql';

const url = 'postgres://warehouse:warehouse@127.0.0.1:55432/warehouse';
const warehouse = new PostgresDestination({ url, schema: 'apple_notes' });

const history = new PostgresSyncHistory({ url });
await history.install();

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

A pass is one connection's read over the copies it selected. `validate(connection)` refuses, without I/O, a connection the history cannot record; the pipeline calls it during preflight. `begin(connection, copies)` receives each selected copy with its `coverage` and is durable when it resolves, before the read starts, so a pass that never finishes stays visible as unfinished rather than missing. It returns a `RecordedPass`: `finish(outcomes)` closes it with what each copy loaded, and `fail(error, failureType)` closes a pass that produced no outcomes, such as an invalid connection or a watcher that stopped. A pass ends `succeeded`, `partial`, `failed` or, when its run's signal stopped it, `cancelled`. An optional `progress(progress)` sees each copy while the pass runs, as a `CopyProgress`: its `status` (`running`, then once `complete` or `incomplete`) and the records and deletions the source `emitted` and the destination `committed` so far. It is a live view, such as for a terminal to render; the history need not persist it, and what it throws is ignored and never changes what loads. The helpers `copyStatus`, `passStatus`, `passError` and `passFailureType` derive `succeeded`, `partial` or `failed` (`SyncStatus`), the pass's error text and its failure type from outcomes. `DeclaredCopy`, `RecordedPass` and `CopyProgress` type the contract.

Every failure says whose it is to fix, as Airbyte's `failure_type` does (`AirbyteTracedException`, `airbyte-python-cdk` `utils/traced_exception.py`). Each `LoadFailure` carries a `failureType` that the source decides with `failureType(error): FailureType`: `config` when the upstream refused what the user set up or granted, so only they can fix it, and `system` for everything else, a destination's errors included. A source that says nothing calls every failure `system`. The Apple sources map their SDKs' `*UnavailableError` (macOS access the app's store needs) to `config`, and SQL Server maps its permission and connection errors. `sync_attempts` and `sync_status` carry the pass's `failure_type`: `config` when any of its failures is, `system` for a pass that failed otherwise, and NULL after success, while running, or when cancelled. Each entry of `extraction_coverage.failures` carries its own. Hosts add access guidance only to a `config` failure. Airbyte's `transient_error` has no reader here yet, so elt has no such type.

Coverage is the source's own statement, `coverage(stream): ExtractionCoverage` with `ExtractionCoverage = { description, selection }`: what a pass over that stream asks the upstream for, from the source's configuration (Calendar's `startAt`/`endAt`, Search Console's `siteUrls`), never inferred from the records it finds. `selection` holds the JSON configuration values the description refers to. Every custom source implements it.

`PostgresSyncHistory({ url })` from `elt-postgresql` records into the [warehouse](#warehouse-marts) tables `_warehouse.sync_attempts` and `_warehouse.extraction_coverage`. Its `install()` creates those tables and publishes the `marts` views `sync_attempts`, `extraction_coverage`, `sync_status` and `stream_status`; it is safe to repeat. Run it before the pipeline records its first pass. It grants nothing. It records Postgres destinations only and refuses any other connection during preflight.

## Markdown destination

```ts
import { MarkdownDestination } from '@workspace/elt-markdown';

const markdown = new MarkdownDestination({ path: './exports' });
const exportPipeline = new Pipeline({
  connections: [
    new Connection({
      name: 'apple-notes-markdown',
      source: notes,
      destination: markdown,
      checkpoints,
      steps: [
        new Copy(
          notes.accounts,
          markdown.file('accounts.md', { title: 'name' }),
        ),
        new Copy(notes.notes, markdown.folder('notes', { title: 'title' }), {
          id: 'notes-to-markdown',
          syncMode: 'incremental',
          destinationSyncMode: 'append_dedup',
        }),
      ],
    }),
  ],
});
await exportPipeline.run();
```

`file()` stores the stream in one document; `folder()` stores one record per document. Both retain every record field, including nested JSON. The optional title field supplies headings; otherwise headings use record positions. Values are escaped Markdown text; HTML stays text. Non-JSON values fail instead of being silently discarded or coerced.

Managed v3 documents include a writer comment and base64-encoded JSON record comments alongside their visible sections. Append and deduplication read these canonical records, without parsing rendered Markdown or using a SQL sidecar. These comments are not encryption. Generated files are owned by the export; manual edits are replaced. Earlier layouts have no compatibility reader or migration.

Ordinary overwrite/append requires no key. Folder filenames represent record occurrences, so repeated source IDs remain separate. Deduplicated folders hash the selected key values instead; title changes do not change identity. The old `folder({ key })` option is removed: selected deduplication keys belong to the copy. Reconciliation currently holds the target in memory and republishes its complete contents.

Target names use lowercase letters, digits, hyphens and underscores, beginning with a letter; files additionally end in `.md`. Nested paths and traversal are rejected. Only regular managed files, or managed folders containing only generated record files, can be replaced. Unmanaged files, subdirectories and symlinks are protected; siblings stay untouched.

An incremental copy publishes the whole target at each checkpoint, so a later failure keeps what earlier checkpoints published; a full refresh publishes once. A file publishes with a rename after staging and closing. A folder moves the old directory to a backup before publishing the staged directory. If publication fails, it restores the backup; if restoration also fails, it preserves the sole backup and reports its location. Folder switching has a brief path gap between renames. Publication is not a filesystem-wide or power-loss transaction.

A reload ([resets](#resets)) publishes into a hidden `.markdown-<target>.next` file or folder instead, which takes the target's place by the same rename when the stream ends without a failure. Markdown stores no shape, so a [shape change](#shape-changes) keeps every record as it was written and the copy resumes from its checkpoint. Names starting with `.markdown-` are reserved.

An exclusive `.markdown-<target>.lock` directory prevents cooperating concurrent writes to either layout. Normal completion/failure removes staging and locks unless a recovery backup must remain. Abrupt termination can leave staging, a backup and a stale lock; inspect and restore the backup before removing the lock and retrying.

## Postgres destination

`PostgresDestination({ url, schema })` from `elt-postgresql` loads every table of a connection into one schema, created on first load. The URL carries credentials, so it stays private: `location()` names host, port, database, schema and table, never the user or password. Declarations are checked without connecting.

Inferred columns follow the stream schema, and unlike SQLite the [string formats](#string-formats) get their own types, so readers can do date arithmetic:

| JSON Schema                                     | Postgres                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| `string`                                        | `TEXT`                                                             |
| `string` + `format: 'date'`                     | `DATE`                                                             |
| `string` + `format: 'date-time'`, precision ≤ 6 | `TIMESTAMPTZ`                                                      |
| `string` + `format: 'date-time-local'`, ≤ 6     | `TIMESTAMP`                                                        |
| `string` + `format: 'time-local'`, ≤ 6          | `TIME`                                                             |
| any of those three at precision 7–9             | `TEXT`, sorted with `COLLATE "C"`                                  |
| `string` + `format: 'int64'`                    | `BIGINT`                                                           |
| `string` + `format: 'decimal'`                  | `NUMERIC(precision, scale)`, or `NUMERIC` when undeclared          |
| `string` + `contentEncoding: 'base64'`          | `BYTEA`                                                            |
| `integer`                                       | `BIGINT`                                                           |
| `number`                                        | `DOUBLE PRECISION`                                                 |
| `boolean`                                       | `BOOLEAN`                                                          |
| `array` of any of the above                     | a native array of that type, such as `BIGINT[]` or `TIMESTAMPTZ[]` |

Postgres keeps time to the microsecond, so a time with more fraction digits, such as SQL Server's `datetime2(7)`, stays exact text, which sorts in time order because every value of the column has the same width; cast it (`::timestamp`) for date arithmetic, which rounds. A `TIMESTAMPTZ` keeps the instant, not the offset it was written with.

Arrays keep their element order and load a JSON `null` as SQL `NULL`; readers use `= ANY(...)`, `unnest()` and `cardinality()`, and `marts.catalog` shows the element type. ISO dates count years astronomically and Postgres does not, so year `0000` loads as `0001 BC`, the same day; every other year is written as given.

Explicit columns use `columns.text/integer/real/boolean/date/timestamp/blob(field)` with `.notNull()` and `.primaryKey()`. A plain `blob()` stores BYTEA; `blob().from(file)` streams originals into chunk tables, and `text().from(file).parse(parser)` stores parsed text. See [attachment storage](#attachment-files-and-document-parsing). Table, view and column names follow the [naming rule](#names). A schema name must have at most 63 bytes, must not contain NUL, and must not start with `pg_`.

Connectors describe their data with JSON Schema's `description`: at the root for the source record's meaning, and on each property for the field's meaning, nulls, units and source-local relationships. These annotations belong to the connector; they contain no destination table names. Notes describes all five of its streams and their fields this way.

Each Postgres copy publishes those annotations as native table and column comments. Both inferred and explicitly selected columns retain their source descriptions; omitted columns receive no comments. The table comment distinguishes the source record's meaning from the copy's extraction and loading modes, including append histories where source identities can repeat and deduplication keys and conflict rules. File-derived text identifies its parser; an original-file column describes its UUID and the actual chunk table used to read the bytes. `loaded_at` describes the load that last wrote the row, not source modification or sync health.

Comments are installed with the stream's first commit and replaced on subsequent loads; removing a property description clears its old column comment. Descriptions must be strings without NUL or malformed Unicode, and are checked before storage access. Postgres's native `format` quotes the identifiers and text. Read comments through `obj_description` and `col_description` or a catalog view built over them. A mart that changes a field's meaning must describe that new meaning itself. Current sync status and extraction coverage remain runtime data, not static schema annotations.

A run holds one connection to the schema under a per-schema session advisory lock, so writers to one schema run one at a time; readers never wait on the lock. As in Airbyte's Postgres destination, no transaction stays open between commits, so reading the source holds no locks on the targets and keeps nothing from vacuum, however many tables a run loads. Preparing a stream only checks the stored table and builds its stage, so a run that fails before a stream's first commit leaves nothing of that stream behind. Each stream stages its operations in a session-private `TEMP` table and commits them at its own checkpoints, each commit one short transaction:

- Operations reach the stage in batches of at most 1000 rows or 16 MiB, each sent as one JSON parameter and cast per column, so large text and binary values travel a few at a time. A record too large to send alone, past V8's longest string or Postgres's 1 GB message, fails its stream with an error naming the table, its largest column and its key. Original files wait in a session-private chunk table until the commit moves them.
- A stream's first commit creates its table, comments, index and reader view, and records its writer.
- A commit merges one stream's stage into its table with the result of applying its operations one at a time: staged `DELETE`s remove their keys, only records after a key's last `DELETE` count, `replace` keeps the last and `cursor_newer` the first with the greatest cursor. Text cursors compare by bytes (`COLLATE "C"`). Every row of a run shares one `loaded_at` (`TIMESTAMPTZ`).
- Overwrite empties the table with `DELETE`, not `TRUNCATE`, at its stream's commit: `TRUNCATE`'s exclusive lock would block readers until the commit ends. Until then readers see the previous load. A [reset](#resets) deletes its scope the same way.
- Deduplication upserts on a unique index named after the table and key (`_elt_dedup_<hash>`). The index is created once and rebuilt only when the key changes; a replacing load builds it after emptying the table.
- The writer of each table lives in `<schema>._elt_writers` and follows the [target ownership](#target-ownership) rule.

When a stored table's columns, types or `NOT NULL`s no longer fit the stream, the load [evolves it](#shape-changes) in place before anything is read, as Airbyte's Postgres destination does: `ALTER TABLE` adds a column nullable, drops one the stream dropped (with its chunk table, for a file column), converts a retyped one `USING column::type`, and keeps `NOT NULL` and the primary key on the target's explicit key columns, moving the key when they change, with the reader view recreated over the result. The change waits at most 3 seconds for readers to let go and otherwise fails the copy until the next run; a value that will not convert, rows that repeat a new key, or a mart built on the view fail it loudly and leave the table as it was. A whole-stream [reset](#resets), or an overwrite whose stored table no longer fits, instead reloads into a hidden table, `_elt_next_<hash>`, which the reload's first commit creates; when the stream ends without a failure it is swapped in under the same 3-second wait, dropping the chunk table of a file column it no longer has, and a mart built on the view refuses the swap. Keep checkpoints in the same schema with `PostgresCheckpointStore` ([checkpoint stores](#checkpoint-stores)).

### Reader views

`table.withReaderView(schema, name)` returns the same table target, which a load also exposes as the view `schema.name`: exactly the table's columns and `loaded_at`, with the table's own comments. The view is created in the same commit as its table, so it exists exactly when the table does, and it follows inserts, updates and deletes without being recreated. The stream needs a JSON Schema `description`, and so does every column (file columns and `loaded_at` bring their own); a missing one fails the copy's declaration before any connection reads. The schema must already exist: in the warehouse, `marts` belongs to the reader's contract, and default privileges make the view readable.

A load never replaces an existing view, because replacing a view readers can see would lock them out; it only refreshes the comments, which does not block readers. A view of other columns or of another table is refused, before anything is read, with an error naming it. A changed stream schema rebuilds the table and its view together, as above.

### Documented Postgres views

`publishPostgresViews(transaction, { schema, views })` from `elt-postgresql` publishes ordinary SQL views with native view and column comments. Each `PostgresView` supplies `name`, `query`, `description`, and a `columns` map from output column names to descriptions. The application defines the SQL and meaning; Postgres derives the output types.

Given a `postgres` client `sql` and an existing `raw.notes` table:

```ts
import { publishPostgresViews } from '@workspace/elt-postgresql';

await sql.begin(async (transaction) => {
  await publishPostgresViews(transaction, {
    schema: 'knowledge',
    views: [
      {
        name: 'notes',
        query: 'SELECT id, title FROM raw.notes',
        description: 'One row per note, identified by id.',
        columns: {
          id: 'Source note identifier.',
          title: 'Note title.',
        },
      },
    ],
  });
});
```

Supply trusted application SQL as one query, with every output column described exactly once and nonempty descriptions. Identifiers follow the destination's 63-byte limit. The publisher creates the target schema if needed, serializes publishing with other writers to that schema, and replaces only the supplied views. List dependencies before their dependents: views are dropped in reverse order and created in the supplied order. Dropping never uses `CASCADE`; an outside dependent prevents publication. A savepoint restores the previous views and comments on any failure, even if the caller catches it and continues the transaction. An empty list does nothing.

The caller owns the connection and transaction. Replacing views recreates them, so reapply explicit grants after publication in that same transaction. Default grants still apply. Applications choose which content to expose; in the warehouse, default privileges on `marts` make every published view readable. `PostgresSyncHistory` uses this publisher for its sync views, and the Search Console marts for their content views.

Views reflect the underlying tables as queried; publishing them does not copy rows or schedule refreshes. Read their descriptions through `obj_description` and `col_description`, just like table comments.

## Apple Messages

```ts
import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
} from '@workspace/elt-sqlite';
import { AppleMessagesSource } from '@workspace/source-apple-messages/apple-messages-source';

const source = new AppleMessagesSource(); // ~/Library/Messages/chat.db
const destination = new SQLiteDestination({
  path: './outputs/messages.sqlite',
});

await new Pipeline({
  connections: [
    new Connection({
      name: 'apple-messages',
      source,
      destination,
      checkpoints: new SQLiteCheckpointStore({
        path: './outputs/messages-state.sqlite',
      }),
      steps: [source.messages, source.chatMessages].map(
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

The source reads Messages' own `chat.db` read-only through its SDK, `@workspace/sdk-apple-messages`; Messages.app need not be open. A missing file or a denied grant raises `MessagesUnavailableError` before any copy runs, with the SQLite error as `cause`. A `chat.db` without a column the source reads, as after a macOS release changes its layout, raises `MessagesSchemaError` naming each missing `table.column`, and no stream of that read loads. `npx nx run apple-cli:start -- sync --connector messages` loads every stream incrementally into the import's `data.sqlite`; each attachment file is saved in its `files` folder and referenced by `attachmentRef`.

### Full Disk Access

Messages keeps its history only in `~/Library/Messages/chat.db`; it has no public API for reading messages. macOS guards that folder with **Full Disk Access** and checks it against the _responsible_ process: the terminal app that runs `npx nx run apple-cli:start`. Grant that app Full Disk Access.

### Streams

Every column of Messages' own tables loads, named in camelCase (`is_from_me` → `isFromMe`); foreign `ROWID`s become the related row's `guid`. Archived Foundation values (binary property lists and `NSKeyedArchiver` graphs) load as JSON text, with data as base64 and dates as ISO timestamps; `attributedBody`, a typedstream, stays base64. Only iCloud sync and task bookkeeping (`deleted_messages`, `sync_*`, `kvtable`, `persistent_tasks`, `message_processing_task`, `index_state_metrics`, `_SqliteDatabaseProperties`) is left out.

| Stream                    | Key                                     | Contents and relationships                                                                                                                                                                                                                                                                                                 |
| ------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chats`                   | `guid`                                  | All 28 `chat` columns: identifier, service, display name, group id, style, archived and filtered flags, last read time, and `properties` as JSON.                                                                                                                                                                          |
| `handles`                 | `id`, `service`                         | Phone numbers and email addresses per service, with country and person-centric id.                                                                                                                                                                                                                                         |
| `chatLookups`             | `identifier`, `domain`                  | The identifiers Messages resolves to each chat, with priority.                                                                                                                                                                                                                                                             |
| `chatServices`            | `chatGuid`, `service`                   | Every service a chat runs over.                                                                                                                                                                                                                                                                                            |
| `chatHandles`             | `chatGuid`, `handleId`, `handleService` | Participants of each chat.                                                                                                                                                                                                                                                                                                 |
| `messages`                | `guid`                                  | All 100 `message` columns plus the sender and other handle (`handle`, `handleService`, `otherHandle`, `otherHandleService`): text, direction, sent/read/delivered/edited/unsent/played/recovered times, reactions, replies, effects and flags; `messageSummaryInfo` and `payloadData` as JSON, `attributedBody` as base64. |
| `chatMessages`            | `chatGuid`, `messageGuid`               | Which chat each message belongs to, with the join's `messageDate`, `indexState`, `filterAction` and `filterSubAction`.                                                                                                                                                                                                     |
| `linkPreviews`            | `messageGuid`                           | The rich link a URL message shows, from its `payloadData` archive: `url`, `originalUrl`, `title`, `summary`, `siteName`, `itemType`, `creator`, and the whole `LPLinkMetadata` as JSON.                                                                                                                                    |
| `messageEdits`            | `messageGuid`, `partIndex`, `version`   | Every version of an edited message part, oldest first, from `messageSummaryInfo.ec`: `editedAt`, the decoded `text`, and the raw entry as JSON. Version 0 is the original.                                                                                                                                                 |
| `recoverableMessages`     | `chatGuid`, `messageGuid`               | Recently Deleted: the chat a deleted message came from and its `deleteDate`. Messages keeps the row in `messages` but removes it from `chatMessages`.                                                                                                                                                                      |
| `recoverableMessageParts` | `chatGuid`, `messageGuid`, `partIndex`  | Deleted parts of a message, with `partText`.                                                                                                                                                                                                                                                                               |
| `attachments`             | `guid`                                  | All 25 `attachment` columns (path, transfer name, MIME type, UTI, size, dates, flags, archived info as JSON) and `availableLocally`. Supports file reads.                                                                                                                                                                  |
| `messageAttachments`      | `messageGuid`, `attachmentGuid`         | Which message carries each attachment.                                                                                                                                                                                                                                                                                     |

- **Consistency:** every stream in a run reads through one [read context](#read-context), a read transaction on `chat.db`. The database runs in WAL mode, so all streams see one snapshot however Messages writes meanwhile.
- **Identity:** rows and relationships use `guid`s. `ROWID`s are local and change when Messages in iCloud rebuilds the database.
- **Incremental:** all thirteen are [snapshot streams](#snapshot-streams). Edits, unsends and read receipts change old rows, and chat.db fills in no modification time: `date_updated`, new in macOS 27, is 0 or NULL on every row of the verified history. So each run scans every row, loads the changed ones, and deletes rows that disappeared.
- **Text:** recent macOS versions store the body only in `attributedBody`, an `NSAttributedString` in typedstream form. `text` falls back to its first string, and the archived value is kept verbatim.
- **Edits:** `date_edited` is not a reliable edit marker; Messages left it empty on edited messages in the verified history. `messageEdits` reads the edit history itself.
- **Times:** chat.db counts from 2001-01-01 UTC, in nanoseconds for message dates and in seconds for attachment dates, edit entries and older histories. Both become UTC timestamps; `0` becomes null.
- **Attachments:** a file is read from its original path, never copied to staging. `MacOSDocumentParser` gives each kind its text: documents convert, images (including files without an extension, identified by their bytes) go through Vision text recognition, contact and location cards load as their vCard text, and voice messages and video load null. A file offloaded to iCloud has `availableLocally: false` and null file fields; no public API downloads it, but when Messages does, the flag changes and the next run loads its bytes and text.
- **Watching:** Messages writes through a WAL it keeps open, and FSEvents reports such a file only when it closes, so `observe()` polls `PRAGMA data_version` on its own read-only connection every second. Every commit, including an attachment finishing its download, changes it.

Live verification on **2026-09-25** (macOS 26.6.2, Node.js 26.8.1), running the exporter as a launchd job for a `node` binary granted Full Disk Access, against a history of 12,567 messages, 468 chats, 472 handles and 41 attachments. Probes read schema, counts and aggregates only; no message content left the machine or entered the repository. The test fixture uses the captured table definitions with synthetic rows, and its archives are encoded by `plutil` and `NSKeyedArchiver`.

- **Schema:** every column of the eleven tables is exported, checked against `PRAGMA table_info`. `handle` is `UNIQUE (id, service)`, `chat_lookup` `UNIQUE (identifier, domain)`, `chat_service` `UNIQUE (service, chat)`; `guid`s have no duplicates; the flags read as non-null booleans have no nulls.
- **macOS 27.0** (2026-10-06): chat.db gained twelve columns, all exported: `message.filter_action`, `filter_sub_action`, `is_preview_sent`, `is_preview_delivered`, `date_preview_sent`, `date_preview_delivered`, `date_updated` and `retry_count`; `attachment.preflight_info` and `sensitivity_analysis`; `chat_message_join.filter_action` and `filter_sub_action`. Every value in this history is 0 or NULL, so their kinds and meanings come from Messages' own code in the macOS 27.0 shared cache: it logs the filter codes and retry count as integers and the three dates as it logs `date` and `date_delivered`; `filter_action` and `filter_sub_action` are a message filter's action and sub-action (its SMS sub-actions include Transactional, Promotional and Finance), copied into `chat_message_join` by Messages' own trigger; `retry_count` counts send retries; `sensitivity_analysis` is a Communication Safety analysis. What the preview columns, `date_updated` and `preflight_info` mean is not documented, and the code does not say. A chat.db without them, as macOS 26 writes it, fails with `MessagesSchemaError`. The other eight tables are unchanged, and the test fixtures use the macOS 27.0 definitions.
- **Access:** a read-only open works while Messages holds the WAL (`chat.db` 34.8 MB, `-wal` 424 KB).
- **Text:** 11,435 messages (91%) store their body only in `attributedBody`. All 12,567 archived bodies decode, and in the 1,132 rows that also have `text` the decoded string matches it exactly.
- **Archives:** every stored archive is a binary property list (12,545 `message_summary_info`, 24 `payload_data`, 212 chat `properties`, attachment info) and decodes; `plutil` agrees with the decoder on a real key containing a control character (`cmmS\u0010`).
- **Edits:** 3 messages carry an edit history, 2 versions each, although their `date_edited` is null; version 0's time equals the message's `date`.
- **Link previews:** 22, all with URL, original URL and title; 16 with a summary, 17 with a site name.
- **Times:** message times are nanoseconds (2017 to 2026); attachment `created_date` and edit times are seconds. All convert.
- **Runs:** every stream loads in about 1 s without attachment parsing and 5.5 s with it; a second run writes nothing, and another session's five further runs wrote nothing either. Every join and Recently Deleted row references a loaded message, chat and attachment. Snapshot state is about 2.6 MB of JSON.
- **Recently Deleted:** 3 messages, each loaded with its chat in `recoverableMessages`. 88 other messages belong to no chat and load without one.
- **Attachments:** 6 are on disk and 32 offloaded to iCloud; the stored chunks of the 6 total 702,104 bytes, their exact `totalBytes`. They are group photos and link-preview images; Vision found text in one.

## Apple Mail

`new AppleMailSource({ path: mailDirectory, accounts: new AccountsStore(accountsStorePath) })` reads Mail's store through its SDK, `@workspace/sdk-apple-mail`, which also exports `mailDirectory`. It reads the current version under `~/Library/Mail`, located from `PersistenceInfo.plist`, with one read-only `Envelope Index` transaction per run, and account and server settings from the system Accounts store through `@workspace/sdk-apple-accounts`. Pass another Mail root or Accounts store path to read copies. The identity covers that whole local store; native keys already span accounts. Metadata discovery performs no I/O.

All 42 streams are available as properties and through `discover()`:

| Streams                                                                                                                                                         | Data                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `accounts`, `smtpServers`                                                                                                                                       | Non-secret settings from the system Accounts store as JSON; a mailbox host it does not know, such as On My Mac, keeps what its URL says  |
| `mailboxes`, `mailboxProperties`                                                                                                                                | Index mailbox URLs, counts and native IDs; `.mbox/Info.plist` properties                                                                 |
| `messages`, `subjects`, `summaries`, `generatedSummaries`                                                                                                       | Every native message column, subject/summary dictionaries and generated summary payloads                                                 |
| `addresses`, `recipients`                                                                                                                                       | Address/comment dictionary and positioned recipient relationships, including orphaned native rows                                        |
| `messageMailboxes`, `serverMessages`, `serverMessageMailboxes`                                                                                                  | Local and server mailbox memberships, message state, IMAP identifiers                                                                    |
| `conversations`, `conversationMessages`, `messageReferences`, `messageGlobalData`                                                                               | Conversation membership, reply references, global message status and deferred-action metadata                                            |
| `messageMetadata`, `dataDetectionResults`, `richLinks`, `messageRichLinks`, `protectedMessageData`                                                              | Native JSON, detected values, links and opaque protected payloads                                                                        |
| `brandIndicators`, `brandIndicatorEvidence`, `addressMetadata`, `businesses`, `businessAddresses`, `businessCategories`, `senders`, `senderAddresses`, `events` | Brand/certificate blobs, sender classification, business metadata, S/MIME capabilities and detected event metadata                       |
| `rules`, `ruleConditions`                                                                                                                                       | Synced/local rules, active flags, ordered conditions and original property dictionaries                                                  |
| `smartMailboxes`, `smartMailboxConditions`                                                                                                                      | Saved hierarchy, ordered criteria and original property dictionaries                                                                     |
| `signatures`, `configuration`                                                                                                                                   | MIME signature content and MailData/signature property lists                                                                             |
| `messageFiles`                                                                                                                                                  | One row per indexed message, relative path, local availability, partial flag, size, SHA-256, original EMLX file                          |
| `messageHeaders`                                                                                                                                                | Ordered headers for every MIME part; unfolded/decoded value and original header-line bytes in base64                                     |
| `messageParts`                                                                                                                                                  | MIME tree, media type, charset, disposition, filename, content ID, local availability, size, SHA-256 and decoded text for `text/*` parts |
| `attachments`, `indexedAttachments`                                                                                                                             | Decoded MIME attachments plus indexed attachments whose MIME has not arrived; native attachment-index rows remain separately available   |

Index column names become camel case; `ROWID` becomes `id`. Integer identities and hashes export as decimal strings to preserve 64-bit precision. `messages.id` is the local row ID used by `attachments.messageId`, `messageParts.messageId` and `messageFiles.messageId`; `messages.messageId` is Apple's distinct RFC Message-ID hash. `messageGlobalData.messageId`, `conversationMessages.messageId` and `messageReferences.reference` use that hash. Mailbox URL hosts identify account directories. Keep native multiple-mailbox relationships instead of assuming one folder per message.

Confirmed Unix timestamps become UTC ISO strings. Unconfirmed native date fields retain their numeric value with a `Raw` suffix; nulls stay null. Blob columns become base64 strings. Configuration and opaque native payloads are preserved without guessing undocumented meanings. Passwords, authentication internals, transient queues, derived search indexes and remote-content caches are outside the user-content export.

MIME structure and transfer decoding use `@zone-eu/mailsplit`'s public `Splitter`/`MimeNode.getDecoder()` APIs; `libmime` decodes encoded header words. Apple-specific code reads only the EMLX byte frame and resolves detached downloads. Nested `message/rfc822` attachments remain complete decoded files. The multipart root is `TEXT`, children use dotted MIME part numbers, and a single-part message uses `1`, matching Apple's index before its file arrives. Attachment keys survive later downloads. Full MIME, inline images, calendar invitations, archives, arbitrary binary files and attached messages all retain bytes regardless of text-parser support. The shared document parser returns null for unsupported text extraction.

Each file stays readable while the consumer uses it. Attachment decoding streams into disposable run storage and releases each message after consumption; body text decodes directly into its record without a temporary file. Header-only reads do not decode bodies. Each selected MIME stream rereads the pinned files; temporary content is bounded by one message rather than the archive. Original EMLX files are hashed and checked before/after reading; file replacement or disappearance during a scan fails the stream rather than committing a misleading snapshot. Missing files at the start are recorded as unavailable. Orphan EMLX files absent from the live index are not messages.

Copies use `incremental`, `append_dedup`, the stream's entire primary key and no cursor field. Every run scans all selected records and lists every selected message. `messageFiles`, `messageHeaders`, `messageParts` and `attachments` are [grouped snapshots](#snapshot-streams) with one group per message. A group's fingerprint covers the parser version, the `.emlx` path and stat (device, inode, size, and modification and change times in nanoseconds), the stat of each detached file, and the message's rows in the index's `attachments` table. A message whose fingerprint is unchanged keeps its saved rows without being read, so a run parses only new and changed messages. Selection still runs on every pass: a message that leaves the scope has no group and its rows are deleted. Raise `messageParserVersion` when parsing or these streams' records change, so every message is read again. There are no date, message-count or file-size windows. Changes to flags, membership, bytes and availability update rows; vanished keys emit deletes; an unchanged snapshot writes zero rows. Scan time and checkpoint size grow with the archive; temporary MIME disk grows with the largest message. Destination staging and original-byte storage need additional disk space. SQLite is transactionally consistent, but Mail's filesystem/settings are separate: concurrent changes can fail a stream and require another run.

Watching subscribes to the Mail directory recursively and checks `PRAGMA data_version` every second. It invalidates selected streams on commits or file changes, including attachment downloads that do not change the index, and closes both handles on cancellation/iterator return. It observes Mail's local activity; leave Mail running and syncing for remote changes. Account and server settings come from the system Accounts store, so Mail need not run for them. While `accounts` or `smtpServers` is selected, the watch also checks that store's `data_version` every second; a commit there invalidates only those two streams, and a Mail change invalidates them too, since it can add a mailbox host. An Accounts store the process cannot open is not watched, and each run reports those two streams' failure. A changed Mail version directory requires restarting the watch.

Full Disk Access is required for the exporting process, for Mail's store and for the system Accounts store (`~/Library/Accounts/Accounts4.sqlite`); Mail needs no Automation access. A Mail store this process cannot read, its `PersistenceInfo.plist` or `Envelope Index` missing or access to it denied, raises `MailUnavailableError` on a read and on a watch, while a `PersistenceInfo.plist` that does not parse or an index that is not a database fails as itself; an unreadable Accounts store fails only `accounts` and `smtpServers`, with `AccountsUnavailableError`; an `Envelope Index` without a column the source reads, as after a Mail release changes its layout, raises `MailSchemaError` naming each missing `table.column` ("The Mail index at <path> has a layout this reader does not read (missing …)"), and no stream of that read loads; files changing during a read raise `MailChangingError`. Errors preserve their causes. A pipeline reports failures per stream and retains its prior committed data/checkpoint.

Live probing on 2026-09-26, macOS 26.6.2 (Mail V10), examined the entire local archive: 25,253 EMLX files at the initial inventory (8,533 full and 16,720 partial), 536 detached files, three indexed messages without local files and sixteen orphan EMLX files. Multiple mailbox membership, 64-bit hashes, both IMAP/iCloud account identities, rule flags, nested smart mailboxes and native timestamp units were inspected. The Mail scripting `authentication` property fails for iCloud, so it is not read. MailKit provides extension callbacks rather than historical bulk extraction; scripting per-message reads would cross the process boundary for the whole archive, so the native read-only store supplies content.

### Mail implementation verification

The access-method review selected the read-only index, EMLX and plist files for local history, and the system Accounts store, read by `@workspace/sdk-apple-accounts`, for account and server settings. Mail's scripting dictionary is not used: it needed Automation access and could launch Mail, and a comparison on 2026-10-05 (macOS 27; Exchange, iCloud and Google accounts) matched every scripted account and SMTP field, except an Exchange account's server, port and SSL, which scripting reports as none, 0 and false: the store keeps no port for it, and its EWS URL gives the host and HTTPS. iCloud keeps its TLS setting on the parent account, because the child's `SSLIsDirect` says only whether TLS starts on connecting or through STARTTLS. Manual mailbox export loses index relationships and cannot supply incremental change signals. IMAP/provider APIs describe remote accounts, not this Mac's local folders or downloaded state. MailKit needs an installed extension and offers delivery callbacks, not a historical archive reader. No public native framework supplies all historical Mail records. Native filesystem notifications plus SQLite commit detection cover both file-only downloads and metadata edits; polling scripting objects would repeatedly cross process boundaries.

Checks on 2026-09-26 used Node.js 26.8.1 and macOS 26.6.2:

- `npx nx run apple:typecheck` and `npx nx run elt-sqlite:typecheck` pass. `apple:test` passes all 60 tests; `elt-sqlite:test` passes all 31. The initial Apple baseline passed 56 tests.
- Four Mail integration tests import `AppleMailSource` directly and load through real Pipeline/SQLite/Markdown destinations. They cover all 42 streams, exact file bytes, nested MIME, repeated/empty/encoded headers, 64-bit IDs, missing and later-downloaded content, changed flags/memberships, deletion, unchanged reruns, schema/read failures, checkpoint preservation, filesystem/index watch notifications and cancellation. Fixtures contain only synthetic data and Apple's schema, never personal records.
- Native ImageIO/Vision checks cover 1-, 2- and 3-pixel images through the Mail attachment pipeline. Smaller tracking pixels return null text while retaining their original bytes. Existing PDF, text, image and extensionless HEIC checks pass. Backlog defect #2038 is closed.
- A full live attachment copy without a text parser loaded 1,152 records: 576 locally available files totaling 122,303,823 bytes in 583 SQLite chunks, and 576 unavailable records. Its unchanged second run wrote zero records and zero deletions.
- Mail verification through the Apple exporter completed 40 of 42 streams, loading 25,689 messages, 819,179 headers and 69,324 MIME parts, including 46,251 text parts (1,133,028,667 UTF-8 bytes). All 25,689 stored original EMLX files (1,379,197,940 bytes) were reassembled and verified against their source SHA-256 and size on 2026-09-27. Forty checkpoints committed. The full body snapshot succeeded after changing SQLite to sort only row identifiers; earlier whole-payload sorting exhausted temporary disk on this nearly full Mac. The subsequent entry-point run completed 39 streams: 38 wrote nothing (including messages, EMLX files and headers), and two mailbox-property rows updated. Mail changed EMLX files during the later body and attachment scans, so those streams failed without advancing their saved checkpoints. Repeated native reads of all 33 mailbox plists had stable values/key order and matched the saved export; the mailbox updates were not generated serialization differences.
- A native temporary mbox import appeared through `Pipeline.watch()`, and its read/flag changes reached SQLite. Deletion and signature persistence could not be completed: Mail's delete AppleEvent failed with `-10000`, a subsequent message deletion crashed Mail with `-609`, and the locked Mac prevented UI cleanup. The temporary signature was removed through the scripting API and its native count was zero. The one-message local mailbox `Import/ContextCompiler-Mail-Probe-20260926` still needs UI removal after unlocking. No message was sent.
- The complete configuration stream encounters a denied `MailData/recentSearches.plist` (`EPERM`, also reproduced with native `plutil`); a changing `SyncedFilesInfo.plist` can fail it sooner. The default attachment text copy encounters a corrupt local PDF at message `5597`, part `4`: the detached file starts inside document metadata rather than with a PDF header, and PDFKit rejects it. These errors are preserved; the byte-only copy above proves attachment extraction independently of text parsing.

The `remove-code` review retained the Apple-specific frame, detached-file lookup, schema validation and file-change checks: no adopted API handles those requirements. It adopted public `Splitter`, `MimeNode.getDecoder()`, `Headers.getList()/getFirst()`, `libmime.decodeHeader()/decodeWords()`, Node streams/TextDecoder/disposable stacks, native `plutil`, and the existing plist decoder, snapshot diff and pipeline. Package export/type/runtime and debug-hook searches found no built-in EMLX reader or archive observation hook. The measured call sites are one source caller each for `readMailMime` and `MailStore.open`, one destination factory for `SQLiteDeduplicatingWriter`, and four parser constructors across the exporter and public integration tests. Public exports and documentation remain because callers also exist outside this repository.

- **Removed:** the new archive-wide MIME cache and body staging, replaced by a per-message read using native stream decoding; the exact-byte, body, unchanged-rerun and error tests pass. Disposable stacks own resources; a redundant constructor cleanup catch and duplicate text-decoder setup were removed. SQLite now ranks staged row IDs instead of entire payloads, fetching winning rows by primary key; its sequential-operation equivalence tests pass. A native transaction-rollback test proves that the original error and previously committed rows survive.
- **Net delta:** 2,515 lines added and 39 deleted (+2,476), including all five new source/platform/test files, dependency manifests, exports, documentation, default exporter registration and the small SQLite correction. This is additive because it introduces the 42-stream connector and its synthetic native-store integration tests. Counts exclude the pre-existing engine/destination work and earlier skill relocation; completed temporary probe scripts and package extracts were removed.
- **Retained:** the source and platform readers, declarative native table schema, public integration tests, README/reference and dependency declarations. These provide the requested connector, native format boundary, API and reproducible checks. No separate connector cache, scheduler, migration or compatibility path remains.
- **REJECTED:** high-level `mailparser` hides stable MIME part paths; mailsplit's `Streamer` can transform flowed text, so it cannot guarantee original attachment bytes. `Headers.getDecoded()` drops empty values and does not decode encoded words; the ordered public header list plus `libmime` preserves both. Per-message AppleScript and MailKit do not meet the local bulk-history requirement.
- **Self-audit:** no added compatibility branch, suppression directive, guessed native date epoch or catch-and-empty fallback remains. Nullable MIME values correspond to `mime-node.js` lines 150–163 (`false` for unavailable parsed values) and `headers.js` lines 90–100 (empty string for an absent header). Mailsplit owns missing Content-Type inference (lines 122–143); TextDecoder owns its charset default. Missing downloaded files/plists are observed upstream states, while failed reads throw. Null account-cache initialization only shares one native call per run. The source path is explicit.
- **Unproven/unresolved:** live deletion/signature persistence and a completely successful default run remain limited by the specific native Mail, access and corrupt-file failures above. A quiet full-body rerun was prevented by Mail changing files during the repeat scan; the earlier full body export succeeded and the prior checkpoint survived this failure. Synthetic tests cover these stream contracts; they do not establish the blocked native behavior. The UI cleanup request is pending until the Mac is unlocked.

- [x] Probing: access methods and change signals reviewed, full-archive live checks run.
- [x] Source written with snapshot incremental sync and deletions.
- [x] Black-box tests through source classes and real destinations.
- [x] README and reference updated.
- [x] Gotchas checked: failed reads throw, keys are unique, fingerprints contain no generated read timestamps, native schemas are detected, and catalog validation stays in the base source.
- [ ] Fully green real-upstream run and native CRUD cleanup: blocked by the explicitly recorded Mail failures and locked session. The parser defect is closed; no open Mail backlog item replaces these checks.

## Apple Contacts

```ts
import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
} from '@workspace/elt-sqlite';
import { AppleContactsSource } from '@workspace/source-apple-contacts/apple-contacts-source';

const source = new AppleContactsSource(); // ~/Library/Application Support/AddressBook
const destination = new SQLiteDestination({
  path: './outputs/contacts.sqlite',
});

await new Pipeline({
  connections: [
    new Connection({
      name: 'apple-contacts',
      source,
      destination,
      checkpoints: new SQLiteCheckpointStore({
        path: './outputs/contacts-state.sqlite',
      }),
      steps: [source.contacts, source.phoneNumbers, source.emailAddresses].map(
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

The source reads Contacts' own Core Data stores read-only through its SDK, `@workspace/sdk-apple-contacts`: `AddressBook-v22.abcddb` at the root of `~/Library/Application Support/AddressBook` (On My Mac) and one `Sources/<id>/AddressBook-v22.abcddb` per account. Contacts.app need not be open. A store or the `Sources` folder that cannot be opened (missing, or no permission) raises `ContactsUnavailableError`, and a store without a column or Core Data entity the source reads raises `ContactsSchemaError` naming each, both before any copy runs. `npx nx run apple-cli:start -- sync --connector contacts` loads every stream incrementally into the import's `data.sqlite`; each photo is saved in its `files` folder and referenced by `attachmentRef`.

### Access

macOS guards the AddressBook folder with the **Contacts** privacy service, and Full Disk Access covers it too; either works, checked against the responsible process: the terminal app that runs `npx nx run apple-cli:start`. Contacts access prompts once for that app; a dismissed prompt is recorded as a denial and never shows again, so enable the app under **System Settings → Privacy & Security → Contacts**, or grant it [Full Disk Access](#full-disk-access).

Contacts.framework is not used. It needs the Contacts grant itself and exposes less than the stores hold.

### Streams

Every stored attribute of the Core Data model (`ABAddressBook`, version `24A2` on macOS 26) loads, named as the model names it (`ZJOBTITLE` → `jobTitle`). Relationships load as the related record's `uniqueId`, which is the Contacts.framework identifier of contacts and groups (`…:ABPerson`, `…:ABGroup`). Property-list data loads as JSON and other data as base64; dates are UTC timestamps. Labels load raw: Apple's constants look like `_$!<Mobile>!$_`, while custom labels and labels written through AppleScript are plain text. Left out are Core Data's own `Z_` columns, transient attributes, values stored only to sort or search (creation and modification year and yearless offsets, `sortingFirstName`, `sortingLastName`, `nameNormalized`, `addressNormalized`, `lastFourDigits`, `ABCDContactIndex`), and sync bookkeeping (`ABCDInfo`, `ABCDDeletedRecordLog`, `CNCDChangeHistoryClient`, `CNCDProviderMetadata`, `CNCDUnifiedContactInfo`, persistent history).

| Stream                                                                                                                                                                                          | Key                                        | Contents and relationships                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `containers`                                                                                                                                                                                    | `id`                                       | One per store: `source` (the `Sources` folder name, null for On My Mac), `type`, `isAll`, `remoteLocation`, `lastSyncDate`, `meContactId` (the account's "my card"), and the record fields every entity shares.                                                                                      |
| `groups`                                                                                                                                                                                        | `id`                                       | `kind` (`group`, `subscribedGroup`, `smartGroup`), `name`, `containerId`, and a smart group's archived query as JSON.                                                                                                                                                                                |
| `groupMembers`                                                                                                                                                                                  | `groupId`, `contactId`                     | Which contacts each group holds.                                                                                                                                                                                                                                                                     |
| `groupSubgroups`                                                                                                                                                                                | `parentGroupId`, `childGroupId`            | Groups nested in groups.                                                                                                                                                                                                                                                                             |
| `contacts`                                                                                                                                                                                      | `id`                                       | `kind` (`contact`, `subscribedContact`), `containerId`, names and phonetic names, organization, department, job title, `birthdayYear`/`birthdayMonth`/`birthdayDay`, `linkId` (contacts Contacts shows as one), image metadata, `meOfContainerId`, creation and modification times, and sync fields. |
| `notes`                                                                                                                                                                                         | `contactId`                                | The note's `text` and `richTextData`.                                                                                                                                                                                                                                                                |
| `alternateBirthdays`                                                                                                                                                                            | `contactId`                                | The non-Gregorian birthday: `calendarIdentifier` (such as `chinese`), `era`, `year`, `month`, `day`, `isLeapMonth`.                                                                                                                                                                                  |
| `phoneNumbers`, `emailAddresses`, `postalAddresses`, `urlAddresses`, `socialProfiles`, `messagingAddresses`, `relatedNames`, `contactDates`, `calendarUris`, `addressingGrammars`, `likenesses` | `id`                                       | Labeled values: `contactId`, `label`, `isPrimary`, `isPrivate`, `orderingIndex`, and each kind's fields. `messagingAddresses.service` is the service's name (`SkypeInstant`, `JabberInstant`); `contactDates` has `year`, `month`, `day`.                                                            |
| `alertTones`                                                                                                                                                                                    | `id`                                       | A contact's ringtone or text tone.                                                                                                                                                                                                                                                                   |
| `customPropertyValues`                                                                                                                                                                          | `id`                                       | A custom property's value on any record, with the property's `propertyName`, `recordType` and `valueType`.                                                                                                                                                                                           |
| `remoteLocations`                                                                                                                                                                               | `id`                                       | URLs attached to any record.                                                                                                                                                                                                                                                                         |
| `unknownProperties`                                                                                                                                                                             | `recordId`, `propertyName`, `originalLine` | vCard lines Contacts kept without understanding them; the line (base64) is part of the key, and identical lines load once.                                                                                                                                                                           |
| `distributionListConfigs`                                                                                                                                                                       | `groupId`, `contactId`, `propertyName`     | The email, phone or address a group uses for a member.                                                                                                                                                                                                                                               |
| `images`                                                                                                                                                                                        | `contactId`, `kind`                        | A contact's `image` and `thumbnail`: `storage` (`inline` or `external`), `externalId`, `byteLength`, `sha256`. Supports file reads.                                                                                                                                                                  |

- **Consistency:** the [read context](#read-context) opens every store in one read transaction each, so a contact agrees with its phones, groups and photos. Stores commit independently, so two accounts are not pinned to the same instant; no relationship crosses stores.
- **Identity:** `uniqueId`s are UUIDs, unique across stores; `Z_PK`s are local to a store and are never exported. Contacts.framework identifies an account's container as `<source>:ABAccount`, not by the container row's `id`.
- **Dates:** Contacts stores birthdays and dates as noon UTC of the day, in year 1604 when the year is unknown; they load as `year` (null without one), `month` and `day`.
- **Incremental:** all 24 are [snapshot streams](#snapshot-streams). Labeled values carry no modification date and deleted records leave no row; the Core Data persistent history is contactsd's to prune, not a cursor the connector owns. Each run scans every row.
- **Photos:** Core Data keeps a photo inline (`0x01` and the bytes), staged in a temporary file removed once the record is loaded, or in its own file (`0x02` and a UUID) under `.AddressBook-v22_SUPPORT/_EXTERNAL_DATA`, read in place. `sha256` makes a replaced photo a changed record. Other encodings throw. For iCloud contacts the Mac keeps only the thumbnail; the full photo stays in iCloud (`imageReference`), and Contacts.framework reports no image data for them either.
- **Account names:** the stores do not name their accounts; Contacts.framework takes "iCloud" or "Google" from the Accounts framework, which this source does not read. `containers.name` is null.
- **Failures:** a store that cannot be opened stops the run instead of being read as empty, which would delete its account's rows from every target.
- **Watching:** contactsd writes through WALs it keeps open, so `observe()` polls `PRAGMA data_version` on each store, and the `Sources` listing, every second. A commit or an added or removed account yields every selected stream.

Live verification on **2026-09-25** (macOS 26.6.2, Node.js 26.8.1) against three stores: On My Mac with 1 contact, iCloud with 3 and Google with 410. Probes read schema, counts and masked value shapes; field values were inspected only on synthetic probe contacts, which were created through Contacts.app scripting and Contacts.framework and deleted afterwards. The test fixture uses the captured table definitions with synthetic rows.

- **Schema:** the model was read from `ContactsPersistence.framework`, confirming which overloaded `ZABCDRECORD` column belongs to which entity (`ZCONTAINER` groups, `ZCONTAINER1` contacts, `ZNAME1` container name) and which data allows external storage (`imageData`, `thumbnailImageData`).
- **Framework agreement:** for all 414 contacts, identifiers, per-contact counts of phones (470), emails (27), postal addresses (53), URLs (4), social profiles (8) and dates (1), exact thumbnail byte lengths and birthday parts equal a non-unified Contacts.framework fetch.
- **Create, edit, delete:** probe contacts with every scriptable field loaded with the values written, including a year-less birthday and date, a Chinese-calendar birthday, custom and constant labels, Jabber and Skype addresses, a note, group membership, nested groups, and inline (37,107 bytes) and external (159,443 bytes) thumbnails. Changing a job title and removing a phone wrote that contact and one deletion. Deleting the probes removed their contacts and every child row.
- **Photos:** 29 in the verified book: 26 thumbnails and 3 full photos, 4 stored externally. A 985 KB photo saved through Contacts.framework on an iCloud contact kept only its thumbnail locally.
- **Runs:** the first run takes 32 s, almost all of it Vision text recognition on the photos; a second run takes 0.13 s and writes nothing. iCloud and Google syncs rewrite group and container modification times, which load as genuine changes, and runs after they settled wrote nothing.
- **Watching:** a live watch loaded a contact saved through Contacts.framework 0.65 s after the save, and its deletion 0.55 s after that.
- **Unverified:** the book holds no smart or subscribed groups, subscribed contacts, calendar URIs, likenesses, alert tones, custom property values, remote locations, unrecognized vCard lines or distribution list choices, so those streams are covered only by the synthetic fixture. Contacts.framework has no way to create them: a synthetic vCard with `CALURI` and an `X-` line, saved through it, stored neither, and the deprecated AddressBook framework's vCard import saved nothing. Smart groups and distribution lists need the Contacts.app interface, and unrecognized lines a vCard import confirmed in Contacts.app; those manual steps were not run. The deprecated AddressBook framework aborted (`SIGABRT`) while writing a custom property value, and cannot remove the property definition it had created, which stays in the iCloud store without values.

## Apple Reminders

```ts
import { Connection, Copy, Pipeline } from '@workspace/elt';
import { SQLiteDestination } from '@workspace/elt-sqlite';
import { AppleRemindersSource } from '@workspace/source-apple-reminders/apple-reminders-source';

const reminders = new AppleRemindersSource();
const sqlite = new SQLiteDestination({ path: './reminders-eventkit.sqlite' });

await new Pipeline({
  connections: [
    new Connection({
      name: 'apple-reminders',
      source: reminders,
      destination: sqlite,
      steps: (await reminders.discover()).streams.map(
        (stream) => new Copy(stream, sqlite.table(stream.name)),
      ),
    }),
  ],
}).run();
```

Reminders uses **EventKit exclusively**, through the `eventkit` helper (see [Calendar](#apple-calendar)). It does not use Reminders.app's scripting API, and the app need not be open. macOS 27 and full Reminders permission are required for the process running the export. Enable access in **System Settings > Privacy & Security > Reminders**. Calendar permission and Automation permission do not substitute for it. A sandbox can block access even when permission is granted.

All eight streams support full refresh and [snapshot incremental](#snapshot-streams) and work with inferred SQLite tables or Markdown targets. Discovery and validation perform no native reads or permission requests. The first extraction requests permission if undecided, waiting up to 30 seconds. Denied, restricted, pending, and revoked access throw `RemindersUnavailableError`, retaining the process error as its cause. Asynchronous fetches time out after 60 seconds and cancel the request. A nil fetch result is an error; only a successful empty array can clear a target. Failed reads preserve the previous contents of the affected target. Only macOS 27 is supported, because the helper is built for it.

| Stream                 | Contents and relationships                                                                                                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accounts`             | Native EventKit sources: `id`, name, type, delegate flag. May include accounts with no visible reminder lists.                                                                                                                   |
| `lists`                | Native reminder calendars: `id`, `accountId`, name, type, writable/subscribed/immutable flags, sRGB color components, availability and entity masks.                                                                             |
| `reminders`            | Native `id`, `listId`, nullable external identifier, name/body/location/URL, item time zone, nullable creation/modification/completion timestamps, completion flag, priority (0–9). Includes completed and incomplete reminders. |
| `dateComponents`       | Up to two rows per reminder, linked by `reminderId`, with `kind` of `start` or `due`. Preserves native date components, calendar identifier, and nullable time zone.                                                             |
| `attendees`            | Public EventKit participants, when supplied: `reminderId`, position, name/URL, status, role, type, current-user flag. This is not a Reminders sharing/assignment API.                                                            |
| `alarms`               | `reminderId`, position, type, relative offset, absolute timestamp, email/sound, proximity, location title, latitude/longitude, radius in meters.                                                                                 |
| `recurrenceRules`      | `reminderId`, position, calendar identifier, frequency, interval, first weekday, ending date/count.                                                                                                                              |
| `recurrenceRuleValues` | `reminderId`, `ruleId`, component/position, value and optional weekday ordinal; preserves all six public recurrence selectors.                                                                                                   |

Date components preserve undefined values as `null`, including missing clock components for date-only reminders. A null time zone means a floating date/time; it is never silently replaced with UTC. Start, due, and item time zones remain separate. No UTC due instant is invented from a date-only or floating reminder. Native timestamp properties remain UTC ISO strings. Missing start/due properties produce no component row. On macOS 26.6.2, EventKit refused non-Gregorian date-component calendars (`Calendar must be nil or Gregorian`). It also normalized a due time set with only an hour and no calendar: the stored components carried the Gregorian calendar and `minute: 0`. Exports report the components EventKit stores, not the values an app originally assigned.

Native enum values remain integers. Alarm proximity is `0` (none), `1` (arrival), or `2` (departure); a radius of `0` asks the system to choose a radius. Recurrence frequency is `0` (daily), `1` (weekly), `2` (monthly), or `3` (yearly). A zero recurrence count means no count-based limit. Only the next incomplete reminder in a recurring series is exposed by Apple; the source does not invent future occurrences or deliver notifications.

EventKit IDs can change after a full server sync; external identifiers are not universally unique or stable across providers/devices. Child IDs identify positions within the current snapshot; attendees and alarms are numbered in content order (see [Calendar completeness](#completeness-and-limits)). Full-refresh overwrite and snapshot incremental both reconcile deletions; incremental still fetches every reminder each run, because EventKit offers no change feed. Every selected stream comes from one change-free snapshot (see [EventKit consistency](#eventkit-consistency)); the destination still commits each stream on its own, with no pipeline-wide transaction. The helper streams its output with no size cap or process timeout.

See the [EventKit research and implementation notes](eventkit-reminders.md) for API evidence, design choices, and verification.

## Apple Calendar

```ts
import { mkdir } from 'node:fs/promises';

import { Connection, Copy, Pipeline } from '@workspace/elt';
import { SQLiteDestination } from '@workspace/elt-sqlite';
import { AppleCalendarSource } from '@workspace/source-apple-calendar/apple-calendar-source';

await mkdir('./outputs', { recursive: true });
const calendar = new AppleCalendarSource({
  startAt: '2026-09-01T00:00:00.000Z',
  endAt: '2026-10-01T00:00:00.000Z',
});
const sqlite = new SQLiteDestination({
  path: './outputs/apple-calendar.sqlite',
});

await new Pipeline({
  connections: [
    new Connection({
      name: 'apple-calendar',
      source: calendar,
      destination: sqlite,
      steps: (await calendar.discover()).streams.map(
        (stream) => new Copy(stream, sqlite.table(stream.name)),
      ),
    }),
  ],
}).run();
```

Calendar reads EventKit through `CalendarStore` (`@workspace/sdk-apple-eventkit`), which runs `eventkit`, a compiled Swift helper ([helper](../packages/sdks/apple/eventkit/src/helper)). The Nx target `sdk-apple-eventkit:helper` builds it as a universal (arm64 and x86_64) binary into `packages/sdks/apple/eventkit/dist/eventkit-helper`; The host decides which copy runs: `AppleHost.eventKitHelper` names it, the Calendar and Reminders connectors build their store from it, `apple-plugin:bundle` copies the binary to `plugins/apple/server/eventkit-helper` for the plugin, and the CLI passes the package's own `dist/eventkit-helper`. `eventkit read '<json request>'` writes one JSON document per line (account, calendar, occurrence, ICS export, reminder), and `eventkit watch events|reminders` prints `changed` per store change. One read runs one helper process for every selected stream. The helper reports EventKit's values. The store keeps the accounts and calendars inside the requested scope and lists each item's attendees and alarms in content order, because EventKit changes their order between processes; the source builds the rows: IDs, ISO timestamps and positions. macOS attributes access to the app responsible for the process: the terminal, or Codex for the plugin.

Calendar needs macOS 27 and full Calendar access for the process running the export. The first extraction requests access if it is undecided or write-only, through `osascript` (macOS shows no prompt for the helper's own request), waiting up to 30 seconds; the grant goes to the terminal or app running the export. If permission is denied, restricted, or still pending, the helper reports `CALENDAR_UNAVAILABLE` and `CalendarUnavailableError` preserves the native cause and explains how to enable access. A sandbox can block access even when macOS permission is granted. Permission failures never become empty successful exports.

The `calendars` stream's `description` is EKCalendar's private `notes` property, the description Calendar.app shows; a calendar without one exports an empty string. The helper checks for the property and fails the read when a macOS version lacks it. Calendar needs no Automation access and never launches Calendar.app.

The `icsComponents`, `icsProperties`, and `icsParameters` streams read each item's iCalendar export through **private** EventKit API (`EKEventStore` `ICSDataForCalendarItems:preventLineFolding:`, falling back to `:options:`). The helper exports each item once, and only when an ICS stream is selected. It checks for the method first: when a macOS version lacks it, the copy fails with `CalendarIcsUnavailableError` rather than exporting nothing, and an export without any event component fails too. A macOS update can remove or change this API; select only the public streams if that matters more than ICS coverage.

### Streams

All eleven streams support full refresh and snapshot incremental (`append_dedup` keyed by `id`, no `cursorField`; see [snapshot streams](#snapshot-streams)) and work with inferred SQLite tables or Markdown targets. Related collections, whose members carry fields of their own, are separate streams of rows.

| Stream                 | Contents and relationships                                                                                                                                                                                                                                                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accounts`             | EventKit sources: identifier, name, native source type, delegate flag.                                                                                                                                                                                                                                                                               |
| `calendars`            | Identifier, `accountId`, name, description, native type, write/subscription/immutability flags, sRGB components, supported availability and entity masks.                                                                                                                                                                                            |
| `events`               | Expanded occurrences: native identifiers, `calendarId`, title/body/location/URL, start/end, all-day dates, time zone, creation/modification dates, original occurrence date, detached flag, status/availability, birthday contact identifier, geographic location.                                                                                   |
| `attendees`            | `eventId`, position, participant name/URL, native status/role/type, current-user flag. `kind` distinguishes attendees from the organizer.                                                                                                                                                                                                            |
| `alarms`               | `eventId`, position, native alarm type, relative offset in seconds, absolute date, email/sound, proximity and geographic location.                                                                                                                                                                                                                   |
| `recurrenceRules`      | `eventId`, position, calendar identifier, frequency, interval, first weekday, end date and occurrence count.                                                                                                                                                                                                                                         |
| `recurrenceRuleValues` | `ruleId`, `eventId`, component and position, integer value, optional weekday ordinal. Preserves weekdays, month/year days, year weeks, months, and set positions.                                                                                                                                                                                    |
| `icsComponents`        | One row per iCalendar component of a native item (`VCALENDAR`, `VEVENT`, `VALARM`, `VTIMEZONE`, …): `id` `[calendarId, calendarItemId, path]`, `parentId`, `position`, `name`, `uid`, the raw `recurrenceId` with its `recurrenceIdTimeZone` (TZID), and `eventId` when it is exact (the master of a non-recurring event).                           |
| `icsProperties`        | Every property except `DTSTAMP`, with its raw value: `componentId`, `position`, `name`, `value`. Includes `ATTACH`, `RRULE`, `EXDATE`, `RECURRENCE-ID`, `URL`, and vendor properties such as `X-GOOGLE-CONFERENCE` and `X-MICROSOFT-*`.                                                                                                              |
| `icsAttachments`       | One row per `ATTACH`: `uri` (raw), `filename` (`X-APPLE-FILENAME` or `FILENAME`), `formatType` (`FMTTYPE`), `inline`. Supports file transfer: inline base64 content is decoded locally; remote references are downloaded by the `attachments` fetcher given to `AppleCalendarSource`, and a file the fetcher reports as unreachable loads as `null`. |
| `icsParameters`        | One row per parameter value: `propertyId`, `componentId`, `position`, `valuePosition`, `name`, `value` (for example `ATTACH;FMTTYPE`, `ATTACH;FILENAME`, `DTSTART;TZID`).                                                                                                                                                                            |

Native enums and bitmasks remain integers. Missing optional values remain `null`; zero recurrence count means no count-based limit. Schema details are available on each stream's `jsonSchema`.

### Dates and occurrence identity

The required bounds are canonical UTC ISO timestamps with `startAt < endAt`. They select the half-open interval `[startAt, endAt)`: overlapping events are included; a zero-duration event is included when its start lies in the interval. The range is not part of the source identity (`apple-calendar:eventkit`), so an incremental copy can move its window between runs: occurrences that leave it are deleted. Construction, discovery, and preflight perform no native reads.

EventKit expands recurrence and applies deleted/rescheduled occurrence exceptions. The helper queries in windows of at most 365 days, inside one process, to avoid EventKit's silent four-year query truncation; an occurrence that spans windows loads once. An unbounded export is not supported because a repeating series may have no end.

`startAt`, `endAt`, and other timestamps retain native instants as UTC strings. For all-day events, `startDate` and `endDate` separately preserve the local Gregorian dates in EventKit's default time zone. `endDate` is **inclusive**: it is the event's last day. EventKit stores an all-day event as ending one second before the next local midnight. A live probe on **2026-09-24** (macOS 26.6.2, Asia/Amman) saved a one-day and a two-day all-day event from 25 September. They exported `endAt` `2026-09-25T20:59:59.000Z` with `endDate` `2026-09-25`, and `2026-09-26T20:59:59.000Z` with `endDate` `2026-09-26`. Both events had a null `timeZone`. The probe deleted both events and confirmed their removal with a fresh read. To get a half-open range, add one day to `endDate`. A null `timeZone` remains null; it is not replaced with UTC. Timed events have null date-only fields.

The event `id` (also exposed as `eventId`) combines the calendar identifier, the local calendar-item identifier of the series, and the original occurrence date for repeating/detached events. It uses the native original date rather than the rescheduled start; all-day occurrence keys use a calendar date. EventKit gives a moved (detached) occurrence an item of its own, whose external identifier is the series' iCalendar UID with `/RID=` and its original start appended; the helper keys it by its series' item, the one item in the same calendar with recurrence rules under that UID, and keeps its own item when there is not exactly one. A live probe on **2026-10-09** (macOS 27, iCloud) moved the second of three weekly occurrences: it came back as item `04218C49…` with external identifier `C61EA281…/RID=758268000` beside the series' `51A2B869…`, and `calendarItems(withExternalIdentifier:)` on the bare UID returned only the series item. Native event and external identifiers remain separate fields; `externalId` drops the `/RID=` suffix, so every occurrence of a series shares it. EventKit identifiers can change after moves or full server syncs, so these are local extraction identities, not permanent cross-device IDs. Child IDs add the collection kind/component and position; they identify snapshot rows, not independently stable native objects.

Per-item recurrence metadata comes from the ICS streams: each native item's `UID`, `SEQUENCE`, raw `RRULE` and `EXDATE` are `icsProperties` rows (an `EXDATE`'s `TZID` is an `icsParameters` row), and a detached item's `VEVENT` carries its series `UID` with a `RECURRENCE-ID`. The structured rules are also in `recurrenceRules` and `recurrenceRuleValues` through public EventKit. Each native item's iCalendar data is exported once per read, without paging.

Calendar's scripting interface is not read. A live comparison on **2026-09-25** (macOS 26.6.2) over 2,786 native items from 2000-01-01 to 2027-09-25 found that its event properties added nothing the ICS export lacks: its UID is EventKit's `calendarItemIdentifier` (the series' for the 140 detached items), its recurrence string re-serializes the same rule (adding `INTERVAL=1`, changing `WKST`), its sequence matched `SEQUENCE`, and its excluded dates covered 67 series where `EXDATE` covered 127. It cost about 55 ms per event for each property, batched or not: 17 minutes for six properties of 3,337 events, against about 35 seconds for the ICS export.

Markdown uses the same source; for example, `new Copy(calendar.events, markdown.folder('events', { title: 'name' }))`. Use lowercase target names such as `recurrence-rules` for camel-cased streams.

### Completeness and limits

Full-refresh overwrite and snapshot incremental both reconcile deletions and events moved outside the selected window on the next successful run; incremental writes only the rows that changed. Ordinary append retains observations. Child rows are keyed by position in content order, not EventKit's order: EventKit returns an item's attendees and alarms, and its ICS export an item's sibling components (a series' exceptions and their alarms), in a different order in each process. A live check on **2026-09-25** (macOS 26.6.2) found two runs minutes apart with no edits rewriting 2,600 attendee, 684 alarm and 1,294 ICS component rows, each event's set identical and only reordered; property and parameter order was stable. Attendees are ordered by URL, name, role and type (not status, so a reply updates its row in place), alarms in firing order (relative alarms by offset, then absolute alarms by date, then their other fields), and ICS components by their content. Adding or editing a child can renumber its siblings. Every selected stream comes from one change-free snapshot (see [EventKit consistency](#eventkit-consistency)), so relationships between streams agree; the destination still commits each stream on its own. The helper streams its output with no size cap or timeout. Duplicate tracking retains occurrence/child IDs for the duration of one copy.

The source preserves the EventKit fields above. These remaining capabilities require more than another source field:

- **Change feed:** EventKit provides change notifications but no durable change cursor, so every incremental run still reads the whole window.
- **Attachment bytes and travel time:** attachment files load only through the `attachments` fetcher, because exported references need provider authorization. `googleCalendarAttachments(requester)` downloads Drive files (native Google files as PDF, shortcuts followed, link-shared files with their resource key) and Gmail attachment references, given a `google-auth` requester with Drive and Gmail read scopes. It resolves false for other URLs and for files the account cannot open, including Google files too large to export as PDF (10 MB); rate limits and configuration errors reject. Travel time is not exported. Deprecated open-file alarm URLs are unavailable on modern macOS.
- **Resumable large exports:** these need additional extraction and checkpoint support. Full refresh currently restarts a failed copy, preserving its previous destination contents until the complete replacement succeeds.

See Apple's [EventKit retrieval documentation](https://developer.apple.com/documentation/eventkit/retrieving-events-and-reminders), [occurrence identity](https://developer.apple.com/documentation/eventkit/ekevent/occurrencedate), and [calendar-item identity caveats](https://developer.apple.com/documentation/eventkit/ekcalendaritem/calendaritemidentifier).

### Calendar export probe

A read-only probe on macOS 26.6.2 (2026-09-21) checked Calendar's **File > Export** output:

- **`.ics`:** the sample preserved raw recurrence rules, excluded dates, recurrence IDs, five attachment references, and Google/Microsoft conference properties. It contained no embedded attachment bytes; three references were HTTPS URLs and two were relative query references requiring provider context.
- **`.icbu`:** the archive contained `Calendar.sqlitedb` and `Info.plist`. Its five attachment records had no local file paths or embedded payloads. The database included travel-time columns, but every sampled value was null, so travel-time preservation remains unverified.

These GUI exports are not used. The ICS streams read the same iCalendar data per item through EventKit instead. The archive's private database schema is not a stable public API. Personal probe exports were temporary and are not repository fixtures.

### Attachment files

`icsAttachments` reads attachment bytes only when the target asks for them, and remote references need a fetcher. For Google calendars, the Apple connectors' `googleCalendarAttachments` downloads Drive files (native Docs, Sheets and Slides as PDF, shortcuts followed to their target, link-shared files with their resource key) and Gmail message attachments. It needs a `googleSession` from `google-auth` whose grant has `drive.readonly` and `gmail.readonly`, from an OAuth client whose project enables the Drive and Gmail APIs. A 403 loads the file as null only when Drive or Gmail says the account may not open it; a rate limit, a disabled API or a missing scope fails the copy, which resumes next run. The CLI's Calendar import wires it up this way:

```ts
const requester = await googleSession({
  clientId,
  clientSecret,
  scopes: [GOOGLE_DRIVE_READONLY_SCOPE, GMAIL_READONLY_SCOPE],
  directory: join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
    'context-compiler',
  ),
});
const calendar = new AppleCalendarSource({
  startAt,
  endAt,
  attachments: googleCalendarAttachments(requester),
});
new Copy(
  calendar.icsAttachments,
  sqlite.table('attachments', (c) => [
    c.text('uri'),
    c.text('filename'),
    c.blob('bytes').from(calendar.icsAttachments.file),
  ]),
);
```

A Drive file the account cannot open (HTTP 404, or a 403 that is not a configuration error) loads with a `null` file. A disabled API, a missing scope, or any other failure fails the copy.

### ICS export verification

On **2026-09-24** (macOS 26.6.2, Asia/Amman) read-only probes exported every item within ±180 days (960 items) and printed only property names and counts:

- Both private selectors exist. No export was empty, and the largest item was 92 KB.
- Every detached item's export carries its own `RECURRENCE-ID` with `TZID`; a recurring master's export can also include its override `VEVENT`s.
- Vendor properties arrive intact: `X-GOOGLE-CONFERENCE` (33 events), `X-GOOGLE-CALENDAR-CONTENT-TITLE`, `X-MICROSOFT-CDO-*`, and `X-APPLE-STRUCTURED-LOCATION` with its parameters. No `ATTACH` occurred in that window. A second probe walked the whole history (2005–2030 in three-year windows, 3,286 items) and found 4 items carrying 5 `ATTACH` properties from 2021–2023. Reading those days through `AppleCalendarSource` loaded all 5 as `icsProperties` rows with 13 `icsParameters` rows: 3 `FMTTYPE`, 5 `VALUE=URI` and 5 `X-APPLE-FILENAME`. Three values are HTTPS URLs and two are relative references that need provider context, matching the GUI export above. None carried inline bytes. Downloading them on **2026-09-24** through `googleCalendarAttachments`, with one account (the calendars' own) and a Desktop client of the project that enables Search Console, Drive and Gmail:

- Both Gmail references downloaded byte-for-byte. A 102,262-byte PNG and a 115,390-byte PDF matched the Gmail message parts' sizes and file signatures, confirming that `attid=0.N…` maps to part `N…` of message `th`.
- The three Drive references returned 404 for the account. Its Drive, including trash and shared drives, held no file with any of their names, so the files had been deleted. They loaded as rows with a `null` file.
- Exporting the same items from two processes three seconds apart changed only `DTSTAMP`, for all 280 events, and never the structure. `DTSTAMP` is the export time, so the streams omit it.

A live run then saved a temporary weekly event with a URL, a location and an alarm, and detached its second occurrence. It ran `events` plus the three ICS streams incrementally into SQLite:

- The first run loaded everything.
- The second run, with no changes, wrote nothing in any stream.
- After the probe was deleted, the next run removed its three occurrences and all of its ICS rows. A fresh EventKit read confirmed the events were gone.

That last run also rewrote 48 component rows of other items. Four later no-change passes, 15 seconds apart, wrote nothing, so this is attributed to concurrent calendar activity rather than to the export; the cause was not verified.

## Apple Safari

```ts
import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
} from '@workspace/elt-sqlite';
import { AppleSafariSource } from '@workspace/source-apple-safari/apple-safari-source';

const source = new AppleSafariSource(); // ~/Library/Safari and Safari's container
const destination = new SQLiteDestination({ path: './outputs/safari.sqlite' });

await new Pipeline({
  connections: [
    new Connection({
      name: 'apple-safari',
      source,
      destination,
      checkpoints: new SQLiteCheckpointStore({
        path: './outputs/safari-state.sqlite',
      }),
      steps: [source.historyVisits, source.tabs, source.bookmarks].map(
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

The source reads Safari's own stores read-only through its SDK, `@workspace/sdk-apple-safari`; Safari need not be open. `npx nx run apple-cli:start -- sync --connector safari` loads every stream incrementally into the import's `data.sqlite`, read through its `<snake_stream>` views; a download still on disk is saved in its `files` folder and referenced by `attachmentRef`. `new AppleSafariSource({ scope })` selects profiles through `collectionIds` and history visits through `startAt`/`endAt` (see Scope below).

| Store                                  | Where                                                                                              | Streams                                                                                                                          |
| -------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `History.db` (SQLite), one per profile | `~/Library/Safari` for the default profile; `Profiles/<serverId>` in the container for every other | `historyItems`, `historyVisits`, `historyTombstones`, `historyTags`, `historyItemTags`                                           |
| `SafariTabs.db` (SQLite)               | `~/Library/Containers/com.apple.Safari/Data/Library/Safari`                                        | `profiles`, `profileStartPageSections`, `windows`, `windowProfiles`, `windowTabGroups`, `tabGroups`, `tabs`, `tabHistoryEntries` |
| `CloudTabs.db` (SQLite)                | the container                                                                                      | `cloudTabDevices`, `cloudTabs`, `cloudTabPositions`, `cloudTabCloseRequests`                                                     |
| `Bookmarks.plist`                      | `~/Library/Safari`                                                                                 | `bookmarks`, `readingListItems`                                                                                                  |
| `RecentlyClosedTabs.plist`             | `~/Library/Safari`                                                                                 | `closedWindows`, `closedTabs`, `closedWindowActiveTabs`                                                                          |
| `Downloads.plist`                      | `~/Library/Safari`                                                                                 | `downloads`                                                                                                                      |

A run opens only the stores its selected streams read, pins each database in one read transaction and reads each property list once. Stores are separate files, so streams of different stores need not agree, and a store that cannot be opened fails only its own streams: a missing or unreadable file raises `SafariUnavailableError` naming Full Disk Access, and a database without a column the reader reads raises `SafariSchemaError` naming the columns. A failure never reads as an empty store, which would delete every row. Streams of every store support full refresh and snapshot incremental (`append_dedup` on the stream's own key, no `cursorField`; see [snapshot streams](#snapshot-streams)).

### Access

Every store lives under folders macOS guards with [Full Disk Access](#full-disk-access); Safari has no public API, and its AppleScript dictionary reaches only open windows and tabs. The grant goes to the process running the export.

### Profiles

Safari 17 and later keep profiles in `SafariTabs.db`. A profile's `id` is its `external_uuid` and every `profileId` refers to it; the profile Safari starts with is `DefaultProfile` and has no stored title (Safari shows it as Personal once other profiles exist). Its `serverId` names the folder holding its data: the default profile's history is `~/Library/Safari/History.db`, another profile's `Profiles/<serverId>/History.db` in the container. History ids are local to one profile's database, so history streams key on `(profileId, id)` and joins between them must match `profileId` too.

A tab or tab group belongs to the nearest profile folder above it; a group under the root folder belongs to the default profile; each window's own groups belong to the window's profile; a tab's page context names its profile when Safari recorded one. The pinned-tab folders belong to no profile.

### Streams

| Stream                                                                       | Contents and relationships                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `historyItems`                                                               | One URL per profile: visit count, ranking score, Safari's per-day and per-week ranking values (weighted, not raw counts; `bigint[]`), autocomplete triggers (`text[]`), last HTTP status.                                                                                                                                                       |
| `historyVisits`                                                              | Each visit: `itemId`, time, title, load success, non-GET, synthesized, redirect source and destination visits, `origin` (0 this Mac, 1 another device through iCloud), sync generation, attribute mask, score.                                                                                                                                  |
| `historyTombstones`                                                          | Deletions Safari keeps to sync: a cleared range (an unbounded start reads NULL) and the removed URL, plain in `url` or, as Safari 27 stores it, encrypted in `encryptedUrl` (base64).                                                                                                                                                           |
| `historyTags`, `historyItemTags`                                             | Topics Safari derived from history (Wikidata item identifiers) and the items tagged with them.                                                                                                                                                                                                                                                  |
| `profiles`, `profileStartPageSections`                                       | Profiles with symbol, named color and components, own Favorites folder (`favoritesFolderServerId` → `bookmarks.serverId`), and the Start Page sections a profile customized.                                                                                                                                                                    |
| `windows`, `windowProfiles`, `windowTabGroups`                               | Saved windows with their profile, active, local and private groups, and window state (private, popup, minimized, selected tab, bars, sidebar, frame, unsubmitted address text); the profiles each window remembers; the groups a window holds or shows, with each group's active tab.                                                           |
| `tabGroups`                                                                  | Every tab folder with its `kind`: `named`, `unnamed` (synced groups of a profile's ordinary tabs), `local` and `private` (a window's own groups), `pinned`, `privatePinned`, `recentlyClosed`, `favorites` (a group's own Favorites), `device` (one device's unnamed groups), `special`.                                                        |
| `tabs`, `tabHistoryEntries`                                                  | Open tabs, pinned tabs (with the address they return to) and group Favorites; titles and URLs synced and local, times, reader state, opener chain, page language, keywords with weights (`text[]`, `double precision[]`); each tab's back and forward list, oldest first, with the entry shown.                                                 |
| `cloudTabDevices`, `cloudTabs`, `cloudTabPositions`, `cloudTabCloseRequests` | iCloud Tabs as Safari last fetched them: devices (name, model), their tabs, each tab's ordering values (a zlib-compressed JSON list), and pending requests to close a tab elsewhere.                                                                                                                                                            |
| `bookmarks`, `readingListItems`                                              | The bookmark tree (folders, bookmarks, proxies such as History; titles, descriptions typed or fetched, iCloud `serverId`) including the Reading List folder, and Reading List items (added, viewed, preview, image, offline fetch, added on this Mac).                                                                                          |
| `closedWindows`, `closedTabs`, `closedWindowActiveTabs`                      | History › Recently Closed: windows with their state, tabs closed alone or with their window, and each closed window's active tab per group.                                                                                                                                                                                                     |
| `downloads`                                                                  | The Downloads list: URL, saved path, profile, times, bytes, and the file when it is still at `path` (`availableLocally`). For an archive Safari opened on its own, `path` names the archive inside a `.download` folder that no longer exists and `openedPath` the first extracted file; the extracted files move next to it, so no file loads. |

Left out: iCloud sync bookkeeping (`history_events`, `history_event_listeners`, `history_client_versions`, `metadata`, `generations`, `sync_*` tables, CloudKit `system_fields` and `Sync.Data`), derived indexes (`bookmark_title_words`, `folder_ancestors`), WebKit and AppKit state (`SessionHistoryEntryData` form and scroll state, `WindowRestorationArchiveData`, `restoration_archive`), icon caches, AutoFill, form values and passwords, per-site preferences and permissions, and extensions.

### Scope

`collectionIds` names profiles: it selects history, profiles, windows, tab groups, tabs, recently closed windows and tabs, and downloads. Folders of no profile, such as the pinned-tab folders, load under any profile's scope. Dates select history visits, and the history items, tag links and tags those visits reach; tombstones and everything else load whole. Bookmarks, the Reading List and iCloud Tabs belong to no profile and load whole; the Apple plugin leaves them out of a scoped import.

### Changes and deletions

Every stream diffs a whole read of its store against the previous one. Safari's own change records cannot replace that: it expires visits older than its history setting without a tombstone. When Safari launched on 2026-09-30 it removed every visit older than a year (the oldest moved from 2025-08-21 to 2025-09-30) and wrote no tombstone. So `historyVisits` and `historyItems` [expire](#expiring-upstreams) by `visitedAt` and `lastVisitedAt`, the time of a URL's latest visit: a visit or URL that vanished before Safari's horizon keeps its row, and one removed within it is deleted. The horizon is the read's start less `HistoryAgeInDaysLimit` days, plus an hour for a daylight-saving shift. That key holds the day count of General › Remove history items: its menu stores 1, 7, 14, 30 or 365, and Manually 365000. While the key is unset Safari keeps a year, and it reads a value below 1 as one day. Safari also keeps at most 100,000 URLs, dropping the least recently visited in its daily maintenance; past that cap the rows of dropped URLs and visits within the horizon would be deleted (the probed Mac held 8,300). Tags and tombstones do not expire with the history setting (tags here date from 2025-03) and diff as before. A watch polls each database's `data_version` (including a profile's `History.db` created while watching) and each property list's inode, size and modification time every second, and wakes only the streams of the store that changed. It never launches Safari: history from other devices and iCloud Tabs arrive only while Safari runs.

### Safari export probe

Checked live on 2026-09-30 against macOS 27.0 (26A428) and Safari 27.0 by driving Safari, then removing every probe object and confirming each removal with a fresh load:

- `origin`: a visit on this Mac stayed 0 after Safari uploaded it (sync generation 1635); 736 visits synced from an iPhone arrived as 1. Launching Safari after five weeks fetched only the last two weeks of the iPhone's history.
- A second profile wrote its visit to `Profiles/<serverId>/History.db`, not the default `History.db`; its tabs named the profile by `external_uuid`. Deleting the profile (Safari asks to "stop using Profiles" when it is the last extra one) removed its folder, rows and Favorites folder; the next load deleted its history, tabs and groups.
- Deleting a history item wrote a tombstone with an unbounded start and an encrypted 208-byte URL; each of six deletions wrote one, and the next load deleted the visits and items. History › Clear History for the last hour wrote one tombstone with that hour as its range and no URL.
- A bookmark saved with a description stored it as `previewText` with `previewTextIsUserDefined`. New Reading List items reached `Bookmarks.plist` only minutes later, at Safari's next write; removing them and the bookmark deleted their rows.
- Pinning a tab moved it under the `pinned` folder; a new named tab group sat under the root folder with its own `TopScopedBookmarkList` Favorites.
- A plain download recorded its final path; an archive Safari opened on its own recorded paths inside a removed `.download` folder. Clearing the Downloads list emptied `Downloads.plist` and deleted the rows.
- Safari keeps the previous session's windows and tabs in `SafariTabs.db` until the next session replaces them.
- A second load with no changes, with Safari running, wrote nothing.
- Closing an iPhone tab from this Mac's iCloud Tabs (checked 2026-10-01) wrote one close request naming the iPhone as its device, with the tab's URL and id; the next load added it. It stayed until Safari ran on the iPhone, which removed both the request and the tab; the next load deleted both rows.

Unverified: shared tab groups (they need a second iCloud account).

## Apple Books

```ts
import { Connection, Copy, LocalFiles, Pipeline } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteColumns,
  SQLiteDestination,
} from '@workspace/elt-sqlite';
import { AppleBooksSource } from '@workspace/source-apple-books/apple-books-source';

const source = new AppleBooksSource(); // Books' container and its group container
const destination = new SQLiteDestination({ path: './outputs/books.sqlite' });
const files = new LocalFiles({ directory: './outputs/books-files' });

await new Pipeline({
  connections: [
    new Connection({
      name: 'apple-books',
      source,
      destination,
      checkpoints: new SQLiteCheckpointStore({
        path: './outputs/books-state.sqlite',
      }),
      steps: [source.annotations, source.readingDays, source.bookFiles].map(
        (stream) =>
          new Copy(
            stream,
            destination.table(
              stream.name,
              stream.supportsFileTransfer
                ? (columns) => [
                    ...SQLiteColumns.fromSchema(stream.jsonSchema),
                    columns
                      .text('attachmentRef')
                      .from(stream.file.store(files)),
                  ]
                : undefined,
            ),
            {
              id: stream.name,
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
            },
          ),
      ),
    }),
  ],
}).run();
```

The source reads the stores Books and its sync daemon, `bookdatastored`, keep, through its SDK, `@workspace/sdk-apple-books`; Books need not be open. `npx nx run apple-cli:start -- sync --connector books` loads every stream incrementally into the import's `data.sqlite`, read through its `<snake_stream>` views; a book whose bytes are on this Mac is saved in its `files` folder and referenced by `attachmentRef`.

| Store                                                                   | Where                                                                                                      | Streams                                                          |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `BKLibrary-1-091020131601.sqlite` (Core Data)                           | `~/Library/Containers/com.apple.iBooksX/Data/Documents/BKLibrary`                                          | `libraryAssets`, `collections`, `collectionMembers`, `bookFiles` |
| `AEAnnotation_v10312011_1727_local.sqlite` (Core Data)                  | `…/Documents/AEAnnotation` in the same container                                                           | `annotations`                                                    |
| `BCAssetData` (Core Data)                                               | `~/Library/Group Containers/group.com.apple.iBooks/Documents/BCCloudData-BookDataStoreService/BCAssetData` | `assetDetails`, `reviews`                                        |
| `CRDTModelSync-ReadingHistoryModel` (Core Data holding a CRDT document) | `…/BCCloudData-BookDataStoreService/CRDTModelSync-ReadingHistoryModel`                                     | `readingMonths`, `readingDays`, `streakRecords`                  |
| `BKJaliscoServerSource-v09182016.sqlite` (Core Data)                    | `…/group.com.apple.iBooks/Documents/BKJaliscoServerSource`                                                 | `purchases`                                                      |
| `BookTheme.sqlite` (Core Data)                                          | `…/com.apple.iBooksX/Data/Library/Application Support/Books`                                               | `themes`                                                         |
| `com.apple.iBooksX.plist`, `group.com.apple.iBooks.plist`               | each container's `Library/Preferences`                                                                     | `readingGoal`                                                    |
| Book files                                                              | each asset's `ZPATH`, usually `~/Library/Mobile Documents/iCloud~com~apple~iBooks/Documents`               | `bookFiles`                                                      |

A run opens only the stores its selected streams read and pins each database in one read transaction. Every store uses Core Data's persistent WAL and most current rows live only in the WAL, so the reader opens them read-only and never as `immutable`, which would hide them. Stores are separate files, so streams of different stores need not agree, and a store that cannot be opened fails only its own streams: a missing or unreadable file raises `BooksUnavailableError` naming Full Disk Access, and a database without a column the reader reads, a reading history in another format version, or a reading history Books holds as two live documents or as something other than bytes, raises `BooksSchemaError`. Rows already loaded stay; only a store with no reading history document, or none with data yet, reads as empty.

### Access

On macOS 27 a terminal without [Full Disk Access](#full-disk-access) read both containers and iCloud Drive; a process macOS attributes to another app may instead be asked to access other apps' data, and Full Disk Access covers both. Books has no public API or scripting dictionary for its library or annotations.

### Streams

| Stream                                          | Contents and relationships                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `libraryAssets`                                 | Every book, PDF, audiobook and series in this Mac's library: title, authors, genre, language, description, store and EPUB identifiers, `path`, page count, size, reading progress and furthest progress reached, finished state and date, last opened and engaged, ratings, sample, hidden and explicit flags, series membership (`seriesContainerAssetId`). `contentType` is `epub` (code 1) or `pdf` (code 3); other codes keep only `contentTypeCode`. `state` is not whether the file is local. Archived author, narrator and genre lists stay base64. |
| `collections`, `collectionMembers`              | Built-in collections (Finished, Want to Read, Books, PDFs, Downloaded, My Samples, Library, Audiobooks, with fixed `collectionId`s) and those the user made (UUIDs); members by `assetId`, which outlives the book leaving the library.                                                                                                                                                                                                                                                                                                                    |
| `bookFiles`                                     | One row per asset with a path: `format` (`epub-package` or `file`), `availableLocally`, file count, size and latest modification over the package. An EPUB package is exported as one `.epub` (OCF: `mimetype` first and stored, entries in name order, fixed timestamps, so an unchanged package yields the same bytes); a single file, such as a PDF or a zipped `.epub`, as it is.                                                                                                                                                                      |
| `annotations`                                   | Highlights and underlines (`kind` `highlight`, with `underline` and `style`: 0 underline, 1 green, 2 blue, 3 yellow, 4 pink, 5 purple), the reading position Books keeps per book (`readingPosition`), and deletion markers not yet synced (`deleted`, no book, text or location). Text, note, surrounding text, chapter title, EPUB CFI location and offsets, creator and times.                                                                                                                                                                          |
| `assetDetails`                                  | Reading state `bookdatastored` syncs through iCloud, including books read on other devices and absent from this library: progress, furthest progress, finished and still-reading, star rating, audiobook position, and the synced position as an EPUB CFI.                                                                                                                                                                                                                                                                                                 |
| `reviews`                                       | Store reviews the user wrote.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `readingMonths`, `readingDays`, `streakRecords` | Reading history: per day the seconds read (summed over every device's contribution) and the goal in effect; per month the total Books kept after summarizing it and how many days remain; the date each streak length was first reached.                                                                                                                                                                                                                                                                                                                   |
| `readingGoal`                                   | One row: goals on or off, the daily goal in seconds, when it was set, and the current streak.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `purchases`                                     | Store purchases, downloaded or not; download tokens and DRM parameters are left out.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `themes`                                        | Reading themes the user customized.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

Left out: CloudKit mirrors that duplicate the stores above (`ZBCASSETANNOTATIONS`, `BCCloudCollections`, `ZBCREADINGNOWDETAIL`, the widget cache) and the local copy of the reading history (`CRDTModelLocalFile`, a newer format of the same model); sync bookkeeping (`ACHANGE`, `ATRANSACTION*`, sync versions, server change tokens, salts, edit and sync generations, `ZCKSYSTEMFIELDS`, CRDT counters and replicas, `.bcck` files); per-day engagement records in `BDSSecureData` (store impression events, not reading time); transient tables (reading sessions, which Books purges, recents, purge and download queues); telemetry and caches (`BooksMessages`, TipKit, WebKit, the series cache, archived plists, Books.plist, whose local flags are wrong); per-language theme fonts; and secrets (`ZBCSECUREUSERDATUM`, identity tokens, CloudKit user IDs, DRM columns).

### Reading history

The history is a Coherence document (Apple's CRDT framework), signature `crdt` and format version 4, that `bookdatastored` syncs through CloudKit. Its root struct has `months`, a dictionary from `yyyymm` to month objects, and `streakRecords`, from streak length to the date reached. A month holds `days` (day of month to day objects), `lastDayStreakOrdinal` and, once Books summarizes the month and drops its days, `totalTime`. A day holds `readingTime`, a counter where each device keeps its decrements and increments, and `readingGoal`. Months and days are calendar dates in the time zone Books recorded them in.

### Book files

Most books live in iCloud Drive, often as placeholders whose bytes are not on this Mac. Reading a placeholder, or listing one that is a directory, makes macOS download it. The reader reads each item's BSD flags with `/usr/bin/stat` (Node's `stat` has none) and lists a package directory only after its own flags show it is local, checking every entry before descending; any placeholder makes the book `availableLocally: false` with no file. A book downloaded from iCloud without a library change is picked up by the next change or run.

### Changes and deletions

Every stream diffs a whole read of its store against the previous one. A watch polls each database's `data_version`, which changes on every commit by another connection even while Books and `bookdatastored` keep their WALs open, and stats the two preference files.

### Books export probe

Checked live on 2026-10-01 against macOS 27.0 and Books 8:

- 49 library assets (47 EPUB packages, 2 PDFs, all added through iCloud Drive), 8 built-in collections with 114 members, 240 annotations (193 highlights, 38 reading positions, 9 deletion markers with an empty asset ID), 63 synced asset details (14 for books not in this library), 42 months and 18 days of reading history, 7 streak records, and a goal stored as 1800 that Books' settings show as 30 minutes, so reading time and goals are seconds.
- Opening the library with `immutable=1` showed 0 annotations; read-only showed all 240.
- 11 EPUB packages were local and 36 EPUBs and both PDFs were placeholders, while Books.plist listed 13 books as local, 10 of them placeholders. Two loads changed no item's flags.
- Opening a local book in Books in a background window for about 15 minutes added the current month and a day of 487 to the reading history once Books quit, which fits seconds.
- Switching one highlight through yellow, green, blue, pink, purple and underline stored `style` 3, 1, 2, 4, 5 and 0 (with `underline` set only for 0).
- The 11 local EPUBs packaged to `.epub` files `unzip -t` accepts; a second load wrote nothing and kept the same copies.

Unverified: content type and annotation type codes this library does not use; audiobooks, store purchases and reviews (none on the probed Mac).

## Apple Activity

```ts
import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
} from '@workspace/elt-sqlite';
import { AppleActivitySource } from '@workspace/source-apple-activity/apple-activity-source';

const source = new AppleActivitySource(); // ~/Library/Biome and knowledgeC.db
const destination = new SQLiteDestination({
  path: './outputs/activity.sqlite',
});

await new Pipeline({
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

The source reads what macOS records about the user's activity; no app needs to be open. `npx nx run apple-cli:start -- sync --connector activity` loads every stream incrementally into the import's `data.sqlite`, read through its `<snake_stream>` views.

| Store                              | Where                                         | Streams                                                          |
| ---------------------------------- | --------------------------------------------- | ---------------------------------------------------------------- |
| Biome streams (SEGB segment files) | `~/Library/Biome/streams/restricted/<Stream>` | the fifteen streams below named after a Biome stream             |
| `knowledgeC.db` (Core Data, WAL)   | `~/Library/Application Support/Knowledge`     | `knowledgeIntents`, `displayBacklight`, `discoverabilitySignals` |
| `sync.db` (SQLite, WAL)            | `~/Library/Biome/sync`                        | `devices`                                                        |

`sdk-apple-biome` reads Biome's streams and `sync.db`, and `sdk-apple-knowledge` reads knowledgeC. A run opens only the stores its selected streams read, pins each database in one read transaction, and opens them read-only, never as `immutable`. A store that cannot be opened fails only its own streams, and a knowledgeC layout that lacks a column fails only the streams that read it.

### Access

Every store needs [Full Disk Access](#full-disk-access); with it, a terminal read all 818 Biome files on 2026-10-05. Reading Biome without it is unverified, since that needs the grant removed. The system Biome under `/private/var/db/biome` belongs to `_biome` and is not read.

### Streams

| Stream                   | Upstream                              | Kept     | One record per                                                               |
| ------------------------ | ------------------------------------- | -------- | ---------------------------------------------------------------------------- |
| `appFocus`               | Biome `App.InFocus`                   | 28 days  | app coming into or leaving the foreground, on this Mac and synced devices    |
| `screenTimeAppUsage`     | Biome `ScreenTime.AppUsage`           | 28 days  | start or end of usage Screen Time counts, without system interface           |
| `appMenuItems`           | Biome `App.MenuItem`                  | 28 days  | use of an app's menu bar (which app, not which item)                         |
| `appIntents`             | Biome `App.Intent`                    | 28 days  | interaction an app donated, with its decoded `INInteraction`                 |
| `webUsage`               | Biome `App.WebUsage`                  | 28 days  | change of a page's usage Screen Time counts                                  |
| `safariNavigations`      | Biome `Safari.Navigations`            | 28 days  | navigation Safari reports, its time rounded up to the half hour              |
| `documentInteractions`   | Biome `App.DocumentInteraction`       | 28 days  | document an app opened or used                                               |
| `mediaUsage`             | Biome `App.MediaUsage`                | 28 days  | start or stop of media an app played                                         |
| `nowPlaying`             | Biome `Media.NowPlaying`              | 28 days  | Now Playing change, on this Mac and synced devices                           |
| `focusModes`             | Biome `UserFocus.ComputedMode`        | 28 days  | Focus turning on or off                                                      |
| `focusSuggestions`       | Biome `UserFocus.InferredMode`        | 28 days  | start or end of a Focus the system suggested                                 |
| `notificationUsage`      | Biome `Notification.Usage`            | 28 days  | notification event (no title or body)                                        |
| `notificationDeliveries` | Biome `Notification.Delivery`         | 3 days   | notification delivered                                                       |
| `bluetoothConnections`   | Biome `Device.Wireless.Bluetooth`     | 28 days  | Bluetooth device connecting or disconnecting, on this Mac and synced devices |
| `screenshots`            | Biome `Screenshots.Screenshot`        | 1 day    | screenshot taken                                                             |
| `knowledgeIntents`       | knowledgeC `/app/intents`             | 28 days  | app interaction; on a Mac they arrive from the iPhone through knowledge sync |
| `displayBacklight`       | knowledgeC `/display/isBacklit`       | 28 days  | span the display stayed lit or dark                                          |
| `discoverabilitySignals` | knowledgeC `/discoverability/signals` | 730 days | feature-discovery signal macOS times its tips by                             |
| `devices`                | `sync.db` `DevicePeer`                | current  | device Biome syncs with, this Mac included                                   |

The ages are each stream's maximum age, compiled into macOS's BiomeLibrary (`storeConfigurationFor<Stream>` builds a `BMPruningPolicy`); no file on disk states them. Biome streams carry `origin` (`local`, or the synced device's identifier), `segment`, `slot` and `recordedAt`, Biome's write time, plus the record's own time as `occurredAt` where it has one. A few payloads store Unix rather than Mac times, and `appIntents` stores the interaction's time, which can precede its write. Start and end are separate records; a session runs from a start to the next end of the same app and origin.

Left out:

- knowledgeC's `/app/usage`, `/app/mediaUsage`, `/notification/usage` and `/app/webUsage`: they copy Biome's streams (10,167 of 10,200 `/app/usage` end times match `ScreenTime.AppUsage`, 182 of 182 media and 4,731 of 4,782 notifications), and `/app/usage` loses rows unevenly before 28 days.
- Biome's other streams: telemetry (Siri analytics, Lighthouse, IntelligenceFlow), content copies (ProactiveHarvesting, TextUnderstanding), and the user's choice to leave out Siri.Remembers (call and message history synced from an iPhone), Pasteboard, Wallet and Location. HomeKit, Messages.Read and Mail.Search are left out too.
- Streams with no records on the probed Mac, whose fields cannot be typed: `Safari.PageLoad`, `Screen.Sharing`, `App.Activity`, `Audio.Route`, `App.WebApp.InFocus`.
- Fields Biome leaves unnamed or the connector does not name, such as most of `Safari.Navigations`, file bookmark data and constant enums: `payload` holds every record's protobuf, base64, as Biome stored it.

### Presets

Activity ships [presets](#connectors-and-their-hosts) that pair each start with its end: `app_focus_sessions` and `screen_time_sessions` run from a start to the next record of the same device, which is the app's own end or, when it is missing, the next app's start; `media_sessions` and `web_visits` pair a playback's or visit's records by `usageId` (a visit starts at usage state 2 and ends at 1); `focus_mode_spans` and `bluetooth_sessions` run from a start to the next record of the same Focus or Bluetooth device when that record is the end. Each gives `started_at`, `ended_at` and `seconds`, with `ended_at` NULL while the span is open. A focus session counts time in front, not use: on 2026-10-05 the login window held focus for 17–21 hours a night while the Mac was locked, and an Apple Watch's face for days; without those two, no device-day held more than 12.7 hours of app focus.

### Records and identity

A Biome stream folder holds `local/` for this Mac and `remote/<device>/` for each synced device; `tombstone/` folders beside them hold Biome's deletion log. Each file is a preallocated SEGB v2 segment ([CCL's reader](https://github.com/cclgroupltd/ccl-segb/blob/23c3f7d3d969a79627b738ba0a2486c31d675753/ccl_segb/ccl_segb2.py) and Cellebrite's write-up describe it): a 32-byte header whose int32 at byte 4 counts the slots, the records from byte 32 each led by a CRC-32 and an int32, and 16-byte trailer slots counted back from the end of the file, slot k at `size − 16·(k+1)`, holding the record's end offset, state (1 written, 3 deleted, 4 empty) and write time. Biome never compacts a segment, so `(origin, segment, slot)` identifies a record. `codec-segb` (`packages/codecs/segb`) reads the format; `sdk-apple-biome` lists each stream's segments and decodes their records' fields. Only written slots whose CRC matches are records: Biome zero-fills a deleted record in place, and some slots marked written hold zeroes (240 of them across this Mac's files).

### Changes, expiry and deletions

Biome streams diff one [group](#snapshot-streams) per segment, fingerprinted by a hash of its trailer, so a run reads only the segments Biome appended to or deleted from. Size and modification time cannot serve: Biome writes preallocated files in place, and mtime trailed the newest record by up to 236 hours. The header's deletion counter cannot either: it drifted from the deleted slots in 9 of 417 files.

Every stream [expires](#expiring-upstreams) by `recordedAt` (`startedAt` for knowledgeC) at its maximum age, less an hour. Biome prunes a record no sooner than that: each of the 18,305 age-pruning tombstones of the week before 2026-10-05 sat 28.000–29.03 days after a 28-day record. Biome's sync daemon also removes synced copies, with an explicit-deletion reason, 28.6–29.0 days after the record; those expire too. A record removed earlier is deleted: Safari history clearing and Screen Time's `delete-web-history` removed `webUsage` and `safariNavigations` records minutes old. `devices` diffs as a plain snapshot.

- **Limits:** each stream also has an event-count and size cap (`App.InFocus` keeps at most 75,000 records, `Notification.Usage` 30,000, Bluetooth, Safari navigations and both Focus streams 10,000). A stream that reached its cap would prune records younger than its maximum age, and the connector would delete their rows. The probed Mac held 31,772 `App.InFocus` records. Biome's prune runs as a daily maintenance task, so records can outlive their maximum age until it runs.
- **Rebuilding:** rows of records macOS dropped exist only in the import. Clearing a copy, rebuilding the import or turning the connector off loses them for good; a change of a stream's fields keeps them ([shape changes](#shape-changes)).
- **Cost:** a first load of this Mac (about 100,000 records) took 4.4 s and a rerun with no new records 0.7 s; the checkpoint store held 12 MB of snapshot state.

### Watching

A watch polls every minute (`pollIntervalMs`): each selected Biome stream's segment listing and trailer hashes, and `data_version` of knowledgeC and `sync.db`. It wakes only the streams that changed. During a 64-second live check while records arrived, `stat` saw no change, FSEvents on the folder reported nothing, and kqueue reported 45 events for `App.InFocus` but none for `ScreenTime.AppUsage`.

### Activity export probe

Checked live on 2026-10-05 against macOS 27.0 (26A428):

- All 818 Biome files were SEGB v2; `codec-segb` read the 280 segments of every stream with 447,013 intact, 216,461 deleted and 245 unreadable slots, matching an independent reader.
- Field meanings follow each Biome event class's initializer in the dyld shared cache, whose argument order matched the protobuf field numbers wherever the data could check it; `App.MenuItem`, `App.DocumentInteraction`, `Safari.Navigations` and `Notification.Delivery` are named from the data.
- Only the iPhone of 11 remote device folders wrote within the week; its records spanned 27.95 days. `sync.db` names no device.
- `knowledgeIntents` rows all came from the iPhone through knowledge sync; `discoverabilitySignals` reached back to 2025-02.
- A load through `apple-cli` read 19 streams in 6 s; a second load wrote nothing.

Unverified: reading without Full Disk Access; what macOS stores for a device of platform 4; streams with no records here.

## Apple Accounts

```ts
import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
} from '@workspace/elt-sqlite';
import { AppleAccountsSource } from '@workspace/source-apple-accounts/apple-accounts-source';

const source = new AppleAccountsSource(); // ~/Library/Accounts/Accounts4.sqlite
const destination = new SQLiteDestination({
  path: './outputs/accounts.sqlite',
});

await new Pipeline({
  connections: [
    new Connection({
      name: 'apple-accounts',
      source,
      destination,
      checkpoints: new SQLiteCheckpointStore({
        path: './outputs/accounts-state.sqlite',
      }),
      steps: [source.accounts, source.accountDataclasses].map(
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

The source reads the system Accounts store, `~/Library/Accounts/Accounts4.sqlite`, where macOS keeps every account its apps sync through, with the `@workspace/sdk-apple-accounts` SDK; no app needs to be open, and neither the Accounts framework nor any app's scripting is used. `npx nx run apple-cli:start -- sync --connector accounts` loads every stream incrementally into the import's `data.sqlite`, read through its `<snake_stream>` views. Every stream of a run reads one snapshot of the store, a read transaction on a read-only connection, never `immutable`, since accountsd keeps a write-ahead log.

### Access

The store needs [Full Disk Access](#full-disk-access). On 2026-10-05 a terminal with the grant read it, and a launchd job without it got SQLite's CANTOPEN (14), as it did for `~/Library/Messages/chat.db`, while listing `~/Library/Mail` failed with `EPERM`. A store the process cannot open fails every stream with `AccountsUnavailableError`, which names the grant.

### Streams

| Stream               | Upstream                                                            | One record per                                                                                       |
| -------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `accounts`           | `ZACCOUNT`                                                          | account: parent, type, sign-in state, when it was added, owning app, per data class settings as JSON |
| `accountProperties`  | `ZACCOUNTPROPERTY`                                                  | property of an account, its keyed archive decoded to JSON                                            |
| `accountDataclasses` | `Z_*ENABLEDDATACLASSES`, `Z_*PROVISIONEDDATACLASSES`                | data class an account offers or has turned on                                                        |
| `accountTypes`       | `ZACCOUNTTYPE`, `Z_*SUPPORTEDDATACLASSES`, `Z_*SYNCABLEDATACLASSES` | kind of account, with the data classes it can offer and sync as arrays                               |
| `dataclasses`        | `ZDATACLASS`                                                        | kind of data accounts sync, such as mail or calendars                                                |
| `accessOptionKeys`   | `ZACCESSOPTIONSKEY`, `Z_*OWNINGACCOUNTTYPES`                        | option key an app passes to ask for access to a kind of account                                      |
| `authorizations`     | `ZAUTHORIZATION`                                                    | app granted access to a kind of account                                                              |
| `credentialItems`    | `ZCREDENTIALITEM`                                                   | stored credential's expiry; the credential itself lives in the keychain and is not read              |

Core Data names the join tables after entity numbers that change between model versions (`Z_2ENABLEDDATACLASSES` on macOS 27), so the SDK finds each by its name's end. `accounts` also carries `name`, `fullName` and `emailAddresses`, resolved through the parent account as Mail resolves them: its own description, else the parent's (iCloud, Google); its own and the parent's identity address, aliases, Apple ID aliases and iCloud Mail address, in that order and each once. Dates are Core Data seconds since 2001-01-01, converted by SQLite and rounded to the millisecond; a boolean the store does not hold is null.

Left out:

- Authentication material among the properties: the iTunes Store's encrypted last sign-in response (`lastAuthenticationServerResponse`), the Apple ID's next liveness nonce (`nextLivenessNonce`) and Game Center's opaque player record (`GKPlayerInternal`), whole, and `AuthID` inside the identity service's `account-info`. The store holds no passwords.
- Core Data's own bookkeeping: `Z_METADATA`, `Z_MODELCACHE` and `Z_PRIMARYKEY`.

### Changes and deletions

Every stream is a [snapshot stream](#snapshot-streams): a run reads the whole store, an unchanged record writes nothing, and a vanished key deletes its row. The store is small, so a run reads it whole in well under a second.

Each kind of record checks only the columns it reads. A macOS whose layout lacks one fails only the streams that read that table, with `AccountsSchemaError` naming the missing columns, and the others load; Mail, which reads only accounts, keeps loading.

### Watching

A watch polls the store's `data_version` every second through `AccountsStore.version()` and wakes every selected stream on a commit. accountsd commits on its own: a read-only connection saw five commits in five minutes with no account edited on 2026-10-05, so a watch wakes about once a minute, and a pass with nothing changed writes nothing.

### Accounts export probe

Checked live on 2026-10-05 against macOS 27.0:

- The store held 33 accounts of 19 types (31 active), 411 properties under 234 keys, 56 account types, 52 data classes and 7 access option keys (Facebook, LinkedIn, Tencent Weibo and Liverpool), and no authorizations or credential items.
- A load through `apple-cli` took 0.4 s and wrote 33 accounts, 408 properties (the 3 authentication-material properties left out), 67 account data classes, 56 account types, 52 data classes and 7 access option keys; a second load wrote nothing.
- Every account's type, every data class an account or type names, and every account type an access key names resolved within the same snapshot.

- `authorizations` and `credentialItems` read their columns as AccountsDaemon's Core Data model (`accounts30.mom`) declares them: `Authorization.options` is transformable through `NSSecureUnarchiveFromData`, so it is decoded as a keyed archive, and `CredentialItem.expirationDate` is a Core Data date.

Unverified: values of `authorizations` and `credentialItems`. Neither this Mac's store nor its `VerifiedBackup` copy holds a row, and accountsd writes them only for an app that holds Accounts framework entitlements and asks for access to an account type, which no tool here can do.

## Apple Call History

```ts
import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
} from '@workspace/elt-sqlite';
import { AppleCallHistorySource } from '@workspace/source-apple-call-history/apple-call-history-source';

// ~/Library/Application Support/CallHistoryDB/CallHistory.storedata, calls
// that started from 2026-01-01 on
const source = new AppleCallHistorySource(undefined, {
  startAt: '2026-01-01T00:00:00.000Z',
});
const destination = new SQLiteDestination({
  path: './outputs/calls.sqlite',
});

await new Pipeline({
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

The source reads `~/Library/Application Support/CallHistoryDB/CallHistory.storedata`, the CallHistory framework's Core Data store, with the `@workspace/sdk-apple-call-history` SDK. callhistoryd writes it for Phone and FaceTime and fills it from the user's other devices through iCloud (`CallHistorySyncHelper`), so it holds the iPhone's phone calls as well as the Mac's FaceTime calls. No app needs to be open, and neither app nor the framework is used. `npx nx run apple-cli:start -- sync --connector call-history` loads every stream incrementally into the import's `data.sqlite`, read through its `<snake_stream>` views (`calls`, `call_participants`). Every stream of a run reads one snapshot of the store, a read transaction on a read-only connection, never `immutable`, since callhistoryd keeps a write-ahead log.

### Access

The store needs [Full Disk Access](#full-disk-access). On 2026-10-06 a terminal with the grant read it, and a launchd job without it got SQLite's AUTH (23, `authorization denied`), where the Accounts store gave CANTOPEN; both become `CallHistoryUnavailableError`, which names the grant, and fail every stream.

### Streams

| Stream                | Upstream                                  | One record per                                                                       |
| --------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------ |
| `calls`               | `ZCALLRECORD`, its initiator in `ZHANDLE` | call: when, how long, phone or FaceTime, direction, answered, caller ID and blocking |
| `callParticipants`    | `Z_*REMOTEPARTICIPANTHANDLES`, `ZHANDLE`  | other party on a call: several for a group FaceTime call, none for a withheld number |
| `callTimers`          | `ZCALLDBPROPERTIES`                       | the Phone app's call-time totals, in seconds; one record                             |
| `emergencyMediaItems` | `ZEMERGENCYMEDIAITEM`                     | photo or video shared with emergency services during a call                          |
| `saintDavidsCounts`   | `ZSAINTDAVIDSCOUNTS`                      | count CallHistory keeps per call and type code, an Apple feature it does not name    |

The column meanings come from Apple's model, `CallHistory 46.mom` in `CallHistory.framework`, the version the store's `com.apple.callhistory.databaseInfo.plist` names. A call's `id` is `ZUNIQUE_ID`, unique in the store and the same on every device that syncs the call. callhistoryd copies each handle for each call: on 2026-10-06 3,448 `ZHANDLE` rows held 500 distinct addresses and none belonged to two calls, so a participant names a party to one call, not a contact, and the initiator is carried on `calls` rather than as a stream of its own. Core Data names the participant join table after entity numbers (`Z_2REMOTEPARTICIPANTHANDLES` on macOS 27), so the SDK finds it by its name's end.

Only the codes Apple names are decoded, and each keeps its raw value beside it: `kind` from `ZCALLTYPE` (1 phone, 8 FaceTime video, 16 FaceTime audio, after `kCHCallTypeTelephony`, `kCHCallTypeFaceTimeVideo` and `kCHCallTypeFaceTimeAudio`) and `category` from `ZCALL_CATEGORY` (1 audio, 2 video). A code the reader does not know, such as a TTY category or a type Apple adds later, loads with `kind` or `category` null and its number kept. Every other code (disconnect cause, filtering, junk confidence, verification, handle type) is Apple's undocumented number, kept as stored. UUID columns are written as `NSUUID` writes them, in uppercase. `startedAt` is a [`date-time` with `precision` 6](#string-formats): Core Data keeps a date as seconds since 2001-01-01 in a double, which resolves about a tenth of a microsecond today, and 2,121 of the 2,123 calls on 2026-10-06 held a fraction finer than a millisecond, so the SDK writes it to the microsecond rather than through a JavaScript `Date`.

`emergencyMediaItems` and `saintDavidsCounts` are keyed by their Core Data row numbers: their call is optional in the model, so no call-based key is guaranteed.

Left out: Core Data's own bookkeeping (`Z_METADATA`, `Z_MODELCACHE`, `Z_PRIMARYKEY`), and `ZHANDLE` rows no call refers to. The model deletes a call's participant handles with it but only clears the call from its initiator handle, so the 293 such rows on 2026-10-06 are initiators of deleted calls.

### Date range

An import's date range selects calls by `startedAt`, from `startAt` inclusive to `endAt` exclusive. `callParticipants`, `emergencyMediaItems` and `saintDavidsCounts` keep the rows of the selected calls, plus any row that names no call, since it has no date to fall outside. `callTimers` spans every call and loads whole.

### Changes and deletions

Every stream is a [snapshot stream](#snapshot-streams): a run reads the whole store, an unchanged record writes nothing, and a vanished key deletes its row. A call that leaves the store is deleted from the import, whether the user removed it from Recents, Core Data cascaded the deletion, or callhistoryd dropped it. On this Mac every phone call before 2025-07-07, 521 of them, had left the store at once, with no removal in callhistoryd's logs over the next 30 days and no retention rule in CallHistory to name the cause. elt has no way to tell such an upstream loss from a deletion (an `expiresBy` horizon needs a retention rule), so another such cut would delete those calls from the import too.

The SDK checks every column it reads when a snapshot opens: a store from a macOS whose layout lacks one fails every stream with `CallHistorySchemaError`, which names the missing columns, and leaves the import as it was. The participant join table is looked up only when `callParticipants` reads, so a store without it fails that stream alone, naming `Z_*REMOTEPARTICIPANTHANDLES`, while the others load.

### Watching

A watch polls the store's `data_version` every second through `CallHistoryStore.version()` and wakes every selected stream on a commit, such as a new call or one synced from the iPhone. On 2026-10-06 a read-only connection saw callhistoryd commit a new call (2,121 to 2,122 calls), and the next load wrote that call and its participant and nothing else.

### Call History export probe

Checked live on 2026-10-06 against macOS 27.0 (26A428):

- The store held 2,121 calls (2,067 phone calls from 2025-07-07 on, 43 FaceTime video and 11 FaceTime audio calls from 2025-02-27 on), 3,448 handles, 2,108 participant links, one row of call-time totals and no emergency media or Saint Davids counts. 13 calls named no participant.
- A load through `apple-cli` took 0.4 s and wrote 2,121 calls, 2,108 participants and 1 call-time row, every call with a known `kind` and `category`; a second load wrote nothing. `/usr/bin/sqlite3` read every view.
- Two reads with no call in between hashed every table identically, so no value changes per read.

Unverified: values of `emergencyMediaItems` and `saintDavidsCounts`. Both tables are empty here and are tested only against their declared shapes: emergency media exists only after media is shared during an emergency call, and Apple names neither the Saint Davids feature nor its type codes (`ZSAINT_DAVIDS_1` is 0 and `ZSAINT_DAVIDS_2` empty on every call here).

## Apple Notification Center

```ts
import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
} from '@workspace/elt-sqlite';
import { AppleNotificationCenterSource } from '@workspace/source-apple-notification-center/apple-notification-center-source';

// ~/Library/Group Containers/group.com.apple.usernoted/db2/db
const source = new AppleNotificationCenterSource();
const destination = new SQLiteDestination({
  path: './outputs/notifications.sqlite',
});

await new Pipeline({
  connections: [
    new Connection({
      name: 'apple-notification-center',
      source,
      destination,
      checkpoints: new SQLiteCheckpointStore({
        path: './outputs/notifications-state.sqlite',
      }),
      steps: [source.notifications, source.apps].map(
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

The source reads `~/Library/Group Containers/group.com.apple.usernoted/db2/db`, the store usernoted keeps for Notification Center, with the `@workspace/sdk-apple-notification-center` SDK. No app needs to be open, and neither Notification Center nor the UserNotifications framework is used: the framework shows an app only its own notifications. `npx nx run apple-cli:start -- sync --connector notification-center` loads every stream incrementally into the import's `data.sqlite`, read through its `<snake_stream>` views (`notifications`, `apps`, `categories`, `category_actions`). Every stream of a run reads one snapshot of the store, a read transaction on a read-only connection, never `immutable`, since usernoted keeps a write-ahead log.

### Access

The store needs [Full Disk Access](#full-disk-access). On 2026-10-07 a terminal with the grant read it, and a launchd job without it got SQLite's AUTH (23, `authorization denied`) and `Operation not permitted` listing `db2/`, as Mail's store did in the same job; the error becomes `NotificationCenterUnavailableError`, which names the grant, and fails every stream.

### Streams

| Stream            | Upstream                               | One record per                                                            |
| ----------------- | -------------------------------------- | ------------------------------------------------------------------------- |
| `notifications`   | `record`, its `data` property list     | notification Notification Center delivered while an import read the store |
| `apps`            | `app`                                  | app that has posted to Notification Center, with its badge now            |
| `categories`      | `categories`, one list per app         | notification category an app registered, in the order it gave them        |
| `categoryActions` | the same lists, each category's `acts` | button a category puts on its notifications, such as Reply                |

usernoted keeps each notification as a binary property list in `record.data`, under four-letter keys. The reader names the keys whose meaning usernoted's own strings or Apple's public API fix: `titl`, `subt` and `body`; `iden`, the identifier the app gave the request; `thre`, the thread; `cate`, the category; `durl`, the default action URL; `soun.nam`, the sound; `edat`, when usernoted removes it; `intrp`, the `UNNotificationInterruptionLevel` (0 passive, 1 active, 2 time-sensitive, 3 critical); `unct`, the communication content type; and `usda`, the app's own `userInfo`, an NSKeyedArchiver archive that names the record in the app's store (a Messages message GUID, a Mail message ID, a Calendar event, a Codex `conversation_id`). `payload` keeps every key as JSON, named or not, with nested archives decoded where they sit and data as Base64: the communication context `uncc` (a Messages sender's handle), and `orig`, `dest`, `srce`, `resp` and `trig`, whose codes Apple does not document. `style` is usernoted's code from `record.style`, 0 or 1 on macOS 27.

A notification's `id` is the delivery's UUID (`record.uuid`) in uppercase, as `NSUUID` writes it: Activity's `notificationUsage.notificationId`. `requestId` is Activity's `notificationDeliveries.requestId`, matched with its bundle identifier ignoring case. `notifications.bundleId` keeps the app's own case, while `apps.bundleId` is lowercased as usernoted keys it. Notifications posted through the legacy API, such as Script Editor's, carry no request identifier, thread or category. `deliveredAt` and `expiresAt` are [`date-time` with `precision` 6](#string-formats): usernoted keeps seconds since 2001-01-01 in a double with a microsecond fraction.

An app's categories are a list it registers whole, and its texts may be localized, stored as `[key, key, arguments]`; the reader loads the key, which the app's bundle resolves. Categories are keyed by their position in the list: on 2026-10-07 Wallet registered `PDUserNotificationTypeAccountPaymentDue` twice, with different options.

Left out: `delivered` and `displayed`, which list each app's notification UUIDs and so index `record`; `requests`, empty on this Mac and so not typed; and `dbinfo`.

### Date range

An import's date range selects notifications by `deliveredAt`, from `startAt` inclusive to `endAt` exclusive. `apps`, `categories` and `categoryActions` have no date and load whole.

### Changes and deletions

`notifications` is a [forgetting upstream](#forgetting-upstreams): it declares no `emitsDeletes`, so a notification that leaves the store keeps its row, and the rows are a history rather than what Notification Center shows now. usernoted deletes a notification's row when its app withdraws it, the user clears it, a newer one with the same request identifier replaces it, it expires, the app clears its badge, a dismissal syncs from another device, or the app is uninstalled, always with the same `DELETE` under `secure_delete` and no record of why; only the unified log, kept about two days, names the cause. Over 2026-10-05 to 2026-10-07 apps withdrew most of them (cmux 105, Codex 27, Reminders 14, Teams 7). A notification the user cleared therefore stays in the import too. usernoted reuses a deleted row's `rec_id`, so the key is the delivery's UUID, and a replacement loads as a new row beside the one it replaced.

`apps`, `categories` and `categoryActions` are [snapshot streams](#snapshot-streams) with deletions, since they describe the store now: an uninstalled app, removed with its records by usernoted's `app_deleted` trigger, and a category its app no longer registers are deleted. The SDK checks every column it reads when a snapshot opens: a store from a macOS whose layout lacks one fails every stream with `NotificationCenterSchemaError`, which names the missing columns, and leaves the import as it was.

### Watching

A watch polls the store's `data_version` every second through `NotificationCenterStore.version()`; usernoted commits through its WAL on every delivery, withdrawal and badge. One database cannot say which table a commit touched, so each commit wakes every selected stream, and the snapshot diff writes nothing for the unchanged ones. Notification Center holds many notifications for minutes: from 2026-10-06 07:00 to 2026-10-07 13:30 Biome's `Notification.Delivery` logged 168 deliveries (cmux 129, Bluetooth 22, Teams 12) that were gone from the store before a read. A watching pipeline loads each within a second. The Apple hosts import at setup and server start, without watching, so until they refresh an import holds what Notification Center held at each pass.

### Notification Center export probe

Checked live on 2026-10-07 against macOS 27.0 (26A428), usernoted database version 19:

- The store held 59 to 64 notifications from 2026-10-06 07:14 on (usernoted recreated the file on 2026-10-02, and `rec_id` restarted at 1), 141 apps (136 without a badge) and 42 category lists holding 300 categories and 752 actions. Every `data`, `usda` and `uncc` blob decoded with `codec-plist`.
- A load through `apple-cli` took 0.36 s and wrote 63 notifications, 141 apps, 300 categories and 752 actions; a second load wrote nothing. A load a minute later wrote 2 new notifications and kept the 1 usernoted had dropped meanwhile (65 loaded, 64 in the store), and loaded an app's re-registered categories (14 categories, 31 actions written, 8 deleted).
- Expiry: a temporary calendar's event, ending a minute after its alert, posted a Calendar notification with `expiresAt` at the event's end. usernoted logged `Request uuid: … from com.apple.iCal expired` at that end and deleted the row; the next load deleted nothing and kept the notification. `requests` stayed empty throughout, so a Calendar alarm does not pass through it. The calendar was deleted afterwards.
- A [shape change](#shape-changes) keeps what the import holds: on 2026-10-08 an import held a Calendar alert usernoted had expired and deleted, and a load after a field was added to `notifications` re-emitted the 81 notifications the store held, deleted none, and kept the expired one, the new field reading NULL. Before shape changes evolved targets, the same kind of change (`style` made nullable) restarted the copy and dropped such a notification.
- Two reads a minute apart with no delivery returned byte-identical blobs, so no value changes per read.

A dismissal synced from another device needs the user's other device and was not produced; it is a `DELETE` like the others, with no reason stored, so the import keeps the notification as it keeps every removal. `style`, `orig`, `dest` and the action `st` code stay unnamed: Apple does not document them, usernoted's strings list `none`, `banner` and `alert` for its notification style, but Calendar, whose alert style in `com.apple.ncprefs` is alerts, stored `style` 0 while apps set to banners stored 1, so the codes do not map to the setting. `requests` was empty, also while a Calendar alarm fired.

## Apple Wallet

```ts
import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
} from '@workspace/elt-sqlite';
import { AppleWalletSource } from '@workspace/source-apple-wallet/apple-wallet-source';

// ~/Library/Passes
const source = new AppleWalletSource();
const destination = new SQLiteDestination({ path: './outputs/wallet.sqlite' });

await new Pipeline({
  connections: [
    new Connection({
      name: 'apple-wallet',
      source,
      destination,
      checkpoints: new SQLiteCheckpointStore({
        path: './outputs/wallet-state.sqlite',
      }),
      steps: [source.passes, source.passFields, source.passBarcodes].map(
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

The source reads `~/Library/Passes`, where passd keeps this Mac's Wallet passes, with the `@workspace/sdk-apple-wallet` SDK: `passes23.sqlite` records each pass, and `Cards/<id>.pkpass/` holds the bundle its issuer signed. No app needs to be open, and neither Wallet nor PassKit is used: PassKit shows an app only the passes of the types its entitlement names. `npx nx run apple-cli:start -- sync --connector wallet` loads every stream incrementally into the import's `data.sqlite`, read through its `<snake_stream>` views (`passes`, `pass_fields`, `pass_barcodes`, …). Passes come from Pass Viewer, which adds a `.pkpass` file to Wallet on this Mac, and from the user's iPhone through iCloud.

### Access

No grant is needed. On 2026-10-10 a launchd job without Full Disk Access read `passes23.sqlite` and a `pass.json`, while the same job got `authorization denied` from the Notification Center store. A store that cannot be opened, such as on a Mac where Wallet was never used, becomes `WalletUnavailableError`, a `config` failure, and fails every stream.

### Streams

| Stream              | Upstream                                                   | One record per                                                                               |
| ------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `passes`            | `pass`, `pass_annotations`, the bundle's `pass.json`       | pass: issuer, kind, dates, colors, semantic tags, when Wallet added, updated and archived it |
| `passFields`        | `pass.json`'s `<area>Fields` arrays                        | field the pass shows, on its front or behind it: a gate, a seat, a balance                   |
| `passBarcodes`      | `pass.json`'s `barcodes`, or `barcode` when it has no list | barcode: format, the message a scanner reads, its encoding and alt text                      |
| `passLocations`     | `pass.json`'s `locations`                                  | place where Wallet offers the pass on the Lock Screen                                        |
| `passBeacons`       | `pass.json`'s `beacons`                                    | Bluetooth beacon near which Wallet offers the pass                                           |
| `passRelevantDates` | `pass.json`'s `relevantDates` (iOS 18 and later)           | moment or interval the pass is relevant                                                      |
| `passLocalizations` | each `<language>.lproj/pass.strings`                       | text a pass translates, by language and localization key                                     |
| `passImages`        | the images `manifest.json` lists                           | image in the bundle, with the image as its file                                              |

A pass's `id` is passd's `unique_id`, which also names its bundle; `passTypeIdentifier` and `serialNumber` are the issuer's identity for it. Every other stream's `passId` refers to `id`.

`pass.json`'s content is read from the bundle, not from passd's copies (`relevant_pass_dates`, `location`), because the bundle keeps what the copies lose: a date's offset. PassKit's dates are W3C dates with a time zone, such as a departure at `2025-09-15T09:30+08:00`; each loads as a UTC [`date-time`](#string-formats) to the millisecond (`relevantAt`) and the offset it was written with, in minutes (`relevantAtOffset`), the convention the SQL Server source uses. A date without a time zone fails the read. A field's `value` loads as `pass.json` writes it: text or a localization key, a W3C date that `dateStyle` formats, or a number's own digits, read through `JSON.parse`'s source text so a value no double holds keeps every digit; `semantics`, `userInfo`, `personalization` and `passJson` keep numbers the same way. `passJson` is the whole `pass.json` except `authenticationToken`, the credential the issuer's web service takes, which loads nowhere. Barcode messages load: they are what the pass shows for scanning.

Text a pass localizes is its key in `pass.json`, and `passLocalizations` holds each language's text from `pass.strings`, in UTF-8 or UTF-16 (`plutil` reads both). The source does not pick a language: a reader joins on `passId` and `key`. Fields are keyed by their area and position, since an issuer may repeat a key.

passd's own dates (`addedAt` from `ingested_date`, `updatedAt` from `modified_date`, `archivedAt` from `pass_annotations.archived_timestamp`) are seconds since 2001-01-01 in a double, written to the microsecond; `signedAt` is the signature's time, to the second. `sortingState` is `pass_annotations.sorting_state`, which passd's predicates use to split Wallet's stack of current passes from its expired section; Apple does not document the codes. On this Mac it was 0 on the passes without `archivedAt` and 1 on a boarding pass added a day after its flight, archived as it was added. An expired or voided pass stays in Wallet and loads with `expiresAt` and `voided`.

Left out: `pass_group`, whose `group_order` is Wallet's display order and shifts for every pass when one is added (seen live), so loading it would rewrite every pass on each add; `pass_type` and `web_service`, which repeat `pass.json`'s identifiers and URL beside the push token; payment cards' columns and `payment_transaction`, empty on this Mac (no card); the bundles' `signature` and the rendered faces in `Cards/<id>.cache/`. FinanceKit's `~/Library/Finance` stores, which hold Wallet orders and Apple Card and Cash, had never stored a row here and are not read (#2537).

### Changes and deletions

Every stream is a [snapshot stream](#snapshot-streams) with deletions: a run reads every pass, an unchanged record writes nothing, and a pass the user removes, here or on a device that syncs Wallet through iCloud, is deleted with its fields, barcodes and images; passd keeps no record of the removal. An issuer's update replaces the bundle and `modified_date`, and its changed records load in place. A pass whose bundle is missing or whose `pass.json` the reader cannot decode fails the read as `PassBundleError`, naming the pass, rather than leaving the pass out, so the import keeps its rows. The SDK checks every column it reads when it opens the database: a passd layout without one fails every stream with `WalletSchemaError`.

A change made on another device reaches this Mac only when passd fetches Wallet's iCloud zone, which its scheduled activities (`PDPassSyncActivityIdentifier`, `PDCloudSyncCoordinator…` in `ScheduledActivities.archive`) repeat every 86,400 s; its `cloud_store_zone.fetch_timestamp` read 2026-10-10 00:14 UTC. A pass removed on the iPhone at about 08:55 UTC that day had not reached this Mac's store 45 minutes later, while a pass added on this Mac reached iCloud within 16 s. So an import can hold a pass the iPhone removed for up to a day.

passd commits through a rollback journal, not a write-ahead log, so a reader holding the database blocks its commits: the SDK reads its rows in one read transaction and closes the database before it reads the bundles.

### Watching

A watch polls `passes23.sqlite`'s `data_version` every second through `WalletStore.version()` and wakes every selected stream on a commit. On 2026-10-10 a read-only connection saw passd commit twice when a pass was added (once at the add, once 16 s later) and not at all over the rest of 30 idle minutes. FSEvents on `Cards/` would miss archiving, which changes only the database, and PassKit's `com.apple.passkit.sharedcachechanged` notification fired twice in that half hour without a change to any pass.

### Wallet export probe

Checked live on 2026-10-10 against macOS 27.0 (26A428):

- The store held 4 passes, two Qatar Airways boarding passes and two Genius Bar reservations, from 2025-08-19 on; their `pass.json` dates kept offsets of +02:00, +08:00 and +04:00, and the database's instants matched them.
- A pass made with WalletWallet (a third-party signer, dummy data: a generic pass with one location, both `barcode` and `barcodes`, and a millisecond UTC expiry) was added through Pass Viewer's Add to Wallet: passd stored it with `modified_source` 4, where the synced passes had 5, gave it `group_order` 0 and moved every other pass's order by one.
- A load through `apple-cli`, run from a scratch folder so the user's selection stayed as it was, took 0.78 s and wrote the 5 passes, 46 fields, 5 barcodes, 3 locations and 34 images; a second load wrote nothing. `/usr/bin/sqlite3` read every view, every exported image was on disk, and none of the 4 passes' `authenticationToken` appeared in any of the import's 38 files. Every pass's serial number, expiry and number of places matched passd's own record of it.

Unverified: localizations, beacons, `relevantDates`, `personalization.json`, and a new version of a pass replacing the old one. No pass on this Mac carries the first four, WalletWallet's form writes none of them, and its generator gives every pass a new random serial number, so it cannot issue a second version of one; they are tested only against PassKit's documented format. Producing them live needs a signer that controls the whole `pass.json` and its serial number: a Pass Type ID certificate in the developer account, or WalletWallet's API with a key. Payment cards were not read: no card is on this Mac, and adding one needs a real card.

## Slack

```ts
import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
} from '@workspace/elt-sqlite';
import { SlackDesktopSource } from '@workspace/source-slack-desktop/slack-desktop-source';

// ~/Library/Containers/com.tinyspeck.slackmacgap/Data/Library/Application Support/Slack
const source = new SlackDesktopSource();
const destination = new SQLiteDestination({ path: './outputs/slack.sqlite' });

await new Pipeline({
  connections: [
    new Connection({
      name: 'slack',
      source,
      destination,
      checkpoints: new SQLiteCheckpointStore({
        path: './outputs/slack-state.sqlite',
      }),
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

The source reads what the Slack desktop app (Mac App Store build) keeps on this Mac, from its own store, with the `@workspace/sdk-slack-desktop` SDK: no Slack API, token or network. `npx nx run apple-cli:start -- sync --connector slack` loads every stream into the import's `data.sqlite`, read through its `<snake_stream>` views.

The app is Electron, and its web client saves its Redux state in the IndexedDB of `https://app.slack.com`: one record, `persist:slack-client-<workspace>-<user>`, in the object store `reduxPersistenceStore` of the database `reduxPersistence`, per signed-in workspace. Four packages read it, each owning one layer:

| Package                    | Reads                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codec-leveldb`            | LevelDB's files without opening the database: CURRENT and the MANIFEST's version edits name the live tables and logs; the write with the highest sequence wins      |
| `codec-v8-serialization`   | V8's ValueSerializer, formats 13 to 16, object references and all storable values                                                                                   |
| `codec-chromium-indexeddb` | Chromium's IndexedDB keys, database and object store names, Blink's value wrapping (a blob file `FF 11 01`, Snappy `FF 11 02`) and its envelope around V8's bytes   |
| `sdk-slack-desktop`        | Where the app keeps its store, which records are clients, what each slice means, the app's own state in `storage/root-state.json`, its errors and its change signal |

Slack 4.52.171 runs Electron 44 (Chromium 152, V8 15.2), whose V8 writes format 16; Node 26's `v8.Deserializer` refuses it, and 16 changed only how buffer and view sizes are written. Chromium keeps IndexedDB in LevelDB for apps on disk; a move to SQLite exists behind flags off by default as of Chromium main on 2026-10-08.

### Access

The app's container needs [Full Disk Access](#full-disk-access) (or macOS's consent to read another app's data). Without it, or without the app, reading fails with `SlackDesktopUnavailableError`, which names the grant, and fails every stream. Bytes in no format the reader knows (a V8 format above 16, a log record whose checksum fails, a slice of another shape) fail with `SlackDesktopFormatError`, which names the record and field. Either way nothing is deleted. The app's own state, `storage/root-state.json`, is a separate file that only `downloads` reads: one that is not JSON, or whose downloads have another shape, fails only `downloads`, and a damaged IndexedDB fails every stream but `downloads`. A missing `root-state.json` means no downloads.

### Streams

| Stream                   | One record per                                                              |
| ------------------------ | --------------------------------------------------------------------------- |
| `workspaces`             | workspace the app is signed in to and has saved, with the user signed in as |
| `channels`               | conversation the app knows: public and private channels, DMs, group DMs     |
| `channelMembers`         | member of a conversation whose members the app keeps (group DMs)            |
| `members`                | person, bot or app user the app knows in a workspace                        |
| `bots`                   | bot the app knows, such as an integration's sender                          |
| `apps`                   | Slack app the client has loaded                                             |
| `messages`               | channel message the app has held, without thread replies                    |
| `threadReplies`          | thread reply the app has held, never deleted                                |
| `messageAttachments`     | link preview, shared message or integration card under a message            |
| `messageReactions`       | emoji reaction on a message, with who reacted as far as the app knows       |
| `messageFiles`           | file a held message shares, in its order                                    |
| `pins`                   | message pinned in a conversation, with who pinned it and when               |
| `files`                  | file the app has held (upload, snippet, canvas, List), metadata only        |
| `fileShares`             | conversation and message a file was shared in, held or not                  |
| `listRecords`            | row of a Slack List the app opened, its cells as JSON                       |
| `channelSections`        | section of the user's sidebar                                               |
| `channelSectionChannels` | conversation the user put in a section                                      |
| `threadSubscriptions`    | thread the app knows whether the user follows                               |
| `preferences`            | user or workspace preference, its value as JSON                             |
| `userGroupMemberships`   | user group the app checked the signed-in user's membership of               |
| `downloads`              | file the app downloaded, with its bytes while the file is still there       |

Every key carries `workspaceId`. A message's `ts` is Slack's own ID, seconds and microseconds as Slack writes them; `sentAt` is the same instant as a [`date-time` with `precision` 6](#string-formats). `blocks`, attachment `fields` and preference values stay JSON as Slack holds them. A message saved for later carries `savedState` (such as `in_progress`), `savedTodoState` (such as `saved`) and `isSavedArchived`, from the `saved` object the app keeps on the message; the app keeps no list of saved items (`saved.list` and `saved.itemMap` stay empty), so a saved message it does not hold is not known. A snippet's `content` is its whole text. A pin's `pinnedBy` and `pinnedAt` come from the conversation's `pinned_items`, which the app keeps with each pinned message when it loads the pin list, else from the pinned message's own `pinned_info`; both are seconds, and both are NULL when the app holds neither. They live only in `pins`, not on `messages`, so the two cannot disagree. `downloads` reads the app's own state, `storage/root-state.json`, not the IndexedDB: `downloads[<workspace>][<file>]` with `downloadState`, `progress`, `startTime` and `endTime` in milliseconds, and `downloadPath`, the file in `~/Library/Containers/com.tinyspeck.slackmacgap/Data/Downloads` unless the user saved it elsewhere. With file reads, a download carries that file while it is still a file at that path; a moved or deleted one carries none. Objects the client marks `isNonExistent` are its note that a message or member is gone, not a record. Left out: the client's UI state (`view`, `modal`, `searchUi` and the like) and `sundryStorage`, which holds only a cache watermark.

### What the app holds, and deletions

The app keeps every conversation, member and app it knows, but only the messages it has loaded: on 2026-10-08 January held 31 messages in 3 of 13 conversations, and Delivery Associates 28 in 1 of 24. Older history reaches the import only if the app loads it while the import runs, and a free workspace hides messages past 90 days (`isBeyondPlanLimit`).

The client records which ranges of each conversation it holds, `channelHistory[channel].slices[{ start, end, timestamps }]`, and the reads [cover](#partly-held-upstreams) exactly those: a message gone from inside a held range, ends included, or marked `isNonExistent`, was deleted and is deleted here; one outside every range was dropped from the cache and stays. Reactions and attachments follow their message. A workspace whose record the store no longer holds, such as one signed out of, keeps all its rows; every other stream deletes what the app stops listing for a workspace it still holds. The client loads a thread's replies when the thread is opened, marks them `_hidden_reply`, and records no range of them, so `threadReplies` is a [forgetting](#forgetting-upstreams) stream: a reply stays after the app drops it, whether it was deleted or only left the cache. Replies' own reactions and attachments are not loaded. The client keeps `pins.pinsByChannel[channel]`, the pinned messages, and `pins.loadingStateByChannel[channel]`, `loaded` once it has loaded that conversation's whole pin list: a pin gone from a loaded list is deleted, the list staying as `[]` after the last unpin, and the pins of a conversation whose list is `loading` or was never loaded stay. User group memberships are the client's checks of whether the signed-in user is in a group, not a list of groups, so `userGroupMemberships` deletes none. Downloads stay after the user clears Slack's list of downloads: `downloads` deletes none. The app also caches the files, and the rows of the Lists, it loaded: `files`, `fileShares` and `listRecords` keep what they saw, a deletion showing as `isDeleted`, `isTombstoned` or `isArchived` while the app still holds it; `messageFiles` follows its message. The app keeps no file's bytes: its HTTP cache held no `files.slack.com` response, and `urlPrivate` needs Slack's sign-in, so files load as metadata.

### Import scope

Accounts are workspaces and collections are conversations. A date range selects messages, their attachments and reactions by `sentAt`. Pins belong to their conversation, whatever the dates; members, bots, apps, sections, preferences, user group memberships and downloads belong to a workspace, not a conversation, and load whole.

### Watching

The app saves a workspace's whole record into a new blob file every few minutes while it runs and when it quits, and a workspace's record first appears when its client unloads. A watch polls the sizes and modification times of the IndexedDB directory's files and of `storage/root-state.json` every second through `SlackDesktopStore.version()`, so a new download wakes it too; a save wakes every stream, and the snapshot diff writes nothing for those that did not change. The app replaces and deletes the blob it read from; a read that loses that race reads again, up to three times.

### Slack live checks

Checked on 2026-10-08 against Slack 4.52.171 on macOS 27.0:

- The store held one record per workspace: January's (514 KB serialized, 138 slices) and, after Delivery Associates' client unloaded on quit, Delivery Associates' beside it. Each save wrote the record to a new blob number (`…/01/166`, then `16f`, `172`, `178`) of the same size when nothing changed.
- The whole store decoded in 86 ms. `codec-leveldb` found the same 55 live records as an independent reader, and `codec-v8-serialization` matched Node's own deserializer on every storable tag.
- A load through `apple-cli`, narrowed to January, wrote 1 workspace, 13 conversations, 9 members, 2 bots, 5 apps, 31 messages, 9 attachments, 8 sections, 2 thread subscriptions and 1,075 preferences; a second load wrote nothing. Two reads with no save in between returned identical records, so no value changes per read.
- Delivery Associates' record held 22 reactions, 3 edited messages, private channels and group DMs with their members.
- On 2026-10-09 the app saved a direct message it held no message of as one slice with neither `start` nor `end` (`{ timestamps: [] }`); such a slice holds nothing, so it covers none of the conversation's messages. Before that shape was read, it failed every stream of the import.
- On 2026-10-09 a load through `apple-cli`, narrowed to January, wrote 1 workspace, 13 conversations, 9 members, 88 messages, 27 attachments, 3 files and 1,076 preferences across its 21 streams, with no pins, saved messages, snippets, memberships or downloads left after the probe removed them; a second load wrote and deleted nothing.

The client also records `reachedStart` and `reachedEnd` for each conversation, whether its held history reaches the conversation's first and newest message. The reads do not use them. On 2026-10-09, deleting the newest held message of a January conversation left the slice's `end` at the deleted message's ts and `reachedEnd` true, and turned the message into the client's note that it no longer exists, `{ channel, ts, id, isNonExistent: true, __meta__ }`; the read covers that ts, so the message is deleted here.

Also on 2026-10-09, January's record showed each shape the newer streams read, each made in the app for the check: a pinned message in `pins.pinsByChannel` (`{ type: "message", channel, ts }`) with its conversation `loaded`, in the conversation's `pinned_items` (`created` in seconds, `created_by`, and the message) and on the message (`pinned_to`, `pinned_info: { pinned_by, pinned_ts }`), and after the unpin the conversation's list left as `[]`; a message saved for later carrying `saved: { is_archived, state: "in_progress", todo_state: "saved" }`; a snippet whose file carries `content`, mode `snippet`, filetype `text` and mimetype `text/plain`; and in `root-state.json` a completed download (`downloadState` `completed`, `progress` 1, `startTime` and `endTime` in milliseconds, `downloadPath` in the app's Downloads folder). Slack's client also declares pins of type `file` and `file_comment`, which carry no `ts`; none was seen, and one would fail the read with `SlackDesktopFormatError` naming the field. Delivery Associates' record, after its People › User groups page was opened, held `userGroupMembership: { <group>: { isMember } }` (1 group, a member) but no group itself: `userGroups` stayed `{}` and `adminUserGroups` empty, so a group's name and members are not on this Mac. January is on the free plan, which cannot manage user groups (`featureAccess.user_groups__manage` is `{ is_enabled: false, reason: "restricted_plan_level" }`).

Files, Lists and thread replies were checked on 2026-10-09 against the record already on disk for Delivery Associates, reading types and counts only: 13 files (a List, hosted files and snippets) with 2 shares, 10 messages sharing files by ID, 2 List rows whose cells sit under column IDs the List file's `list_metadata.schema` names, and 1 reply in the channel-message shape with `_hidden_reply`.

Not yet verified on real data: calendar events, since no calendar is connected to Slack in either workspace and connecting one is the account owner's consent; the Slack build from slack.com, which keeps its data under `~/Library/Application Support/Slack`; and how the store compacts, since the live database never wrote a table while it was watched (tests cover tables written as LevelDB writes them).

## Google Search Console

`SearchConsoleSource` reads one property through the `searchconsole:v1` API. `sites`, `sitemaps` and `searchAnalytics` are served under the original `webmasters/v3` path prefix; URL inspection is served from `v1` on the same host.

Construct it with an authenticated requester from `googleSession` in `google-auth`:

```ts
const requester = await googleSession({
  clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
  clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  scopes: [GOOGLE_SEARCH_CONSOLE_SCOPE],
  directory: join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
    'context-compiler',
  ),
});
const source = new SearchConsoleSource({
  requester,
  siteUrls: ['sc-domain:example.com', 'sc-domain:example.org'],
});
```

### Authorization

The app signs in with its own **Desktop-type** OAuth client, whose id and secret come from `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`. The read scope is `https://www.googleapis.com/auth/webmasters.readonly`. Search Console authorizes per property; the client's Google Cloud project supplies API quota, so it must have `searchconsole.googleapis.com` enabled.

One-time setup in the Cloud Console (Google has no API for creating Desktop OAuth clients):

1. Configure the OAuth consent screen as External and add the `webmasters.readonly` scope.
2. Set the publishing status to **In production**. An External consent screen in **Testing** is issued refresh tokens that expire after 7 days unless every scope is one of name, email address and user profile, which `webmasters.readonly` is not.
3. Create an OAuth client ID of type **Desktop app** and export its id and secret.

`googleSession` then works like this:

- **First run.** With no stored grant covering the scopes, it listens on `http://127.0.0.1:<random port>/callback`, opens the consent link in the default macOS browser, and waits up to five minutes. Only a redirect carrying the flow's `state` is accepted; any other request gets `400` and the listener keeps waiting.
- **Browser failures.** A failed launch rejects sign-in and closes the callback listener. Other platforms and headless sessions supply `googleSession({ openBrowser })` to handle the consent URL. The library does not print links or errors.
- **Later runs.** The stored grant is reused without a browser. Each access-token refresh is written back before the request that caused it returns.
- **New scopes.** When a later caller needs a scope the grant lacks, consent runs again for the union of old and new scopes, so no earlier permission is dropped.
- **Revoked or expired grants.** When Google refuses the stored refresh token (revoked consent, an expired Testing-mode token, or a Workspace re-authentication demand), consent runs again.

The host decides where grants live: `googleSession` keeps them under `<directory>/google/`, and both the CLI and the Google app pass `${XDG_CONFIG_HOME:-~/.config}/context-compiler`. Grants are stored as owner-only (`0600`) JSON files, written through a temporary file and a rename, so a crash leaves the previous grant intact. This is the same protection gcloud gives its own refresh token; the file is not encrypted. File and directory names are SHA-256 hashes, not account ids. To switch Google accounts, delete that directory; the next run asks for consent.

Because a user credential is billed to the project that issued its OAuth client, no quota-project header is needed. The previous gcloud-import path failed with `SERVICE_DISABLED` / `accessNotConfigured` naming `projects/764086051850`, gcloud's own client project, until a quota project was named.

### Streams

| Stream                                             | Extraction               | Key                                  | Notes                                                                                                                                                                                                                                            |
| -------------------------------------------------- | ------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sites`                                            | Full refresh or snapshot | `[siteUrl]`                          | Properties the grant can read. `siteUnverifiedUser` entries are dropped: Google lists them, but their history cannot be read.                                                                                                                    |
| `sitemaps`                                         | Full refresh or snapshot | `[siteUrl, path]`                    | Google's report on each listed sitemap (int64 counts arrive as decimal strings; `lastDownloaded` is null until Google first reads it), plus what this connector read from the file itself: `urlsRead`, or `readError` when it could not be read. |
| `sitemapContents`                                  | Full refresh or snapshot | `[siteUrl, sitemapPath, type]`       | The per-content-type rows nested in each sitemap.                                                                                                                                                                                                |
| `searchAnalyticsDaily`                             | Incremental              | `[siteUrl, date, searchType]`        | Site-wide totals per day **per report type**, with `searchType` as a column.                                                                                                                                                                     |
| `searchAnalyticsQueries`                           | Incremental              | `[siteUrl, date, query]`             | Per day and query, web results only.                                                                                                                                                                                                             |
| `searchAnalyticsPages`                             | Incremental              | `[siteUrl, date, page]`              | Per day and page, web results only.                                                                                                                                                                                                              |
| `searchAnalyticsCountries`                         | Full refresh or snapshot | `[siteUrl, country, device]`         | Country and device for a trailing `breakdownMonths` window (default 3), stated on each row as `startDate` and `endDate`. No date dimension, so it is diffed as a whole rather than resumed.                                                      |
| `urlInspection`                                    | Incremental (rolling)    | `[siteUrl, inspectionUrl]`           | One request per URL. `inSitemap` and `inSearchAnalytics` say where the URL was found, `inspectedAt` when; `errorStatus` and `errorMessage` are set when Google rejected the URL.                                                                 |
| `urlInspectionSitemaps` / `urlInspectionReferrers` | Incremental (rolling)    | `[siteUrl, inspectionUrl, position]` | The arrays nested in the index status result.                                                                                                                                                                                                    |

One source reads several properties. Every stream except `sites` is a [partitioned stream](#partitioned-streams) with `partitionKey: ['siteUrl']`: each property is read with its own checkpoint, every row carries its property in `siteUrl`, and every key starts with it, so all properties share one table per stream. Adding a property backfills its history while the others resume; removing one stops reading it and keeps its rows. `sites` lists what the grant can read, which is the same for every property, so it is not partitioned.

Every read of the snapshot streams returns the complete list, so an incremental copy (`append_dedup` on the stream's key, no `cursorField`) writes only changed rows and deletes the rest; see [snapshot streams](#snapshot-streams). The inspection streams are rolling instead; see [URL inspection and quota](#url-inspection-and-quota).

The example app lists every property in one source, so each table has one [writer](#target-ownership). To add a property, add it to that source's list; a second connection into the same tables is refused.

#### Why the grains are separate

Google withholds rare queries for privacy, and the loss compounds with every dimension added to a request. Measured against one live property over 2026-09-10 to 2026-09-20:

| Request                                      | Rows | Clicks | Impressions |
| -------------------------------------------- | ---- | ------ | ----------- |
| `['date']`                                   | 11   | 58     | 1986        |
| `['date','query','page','country','device']` | 749  | 37     | 1020        |

A single wide request loses 36% of clicks and 49% of impressions, and no aggregation of it can recover the property's real totals. Each grain is therefore its own stream with its own window: `searchAnalyticsDaily` stays authoritative for totals, and the breakdowns are only comparable within themselves. Google additionally caps a property at 50,000 rows per day per search type and states the API "does not guarantee to return all data rows", so a high-cardinality request receives silent truncation rather than an error.

Consequences for anything querying these tables: average `position` must be weighted by impressions over non-null rows, `ctr` must be recomputed as `SUM(clicks) / SUM(impressions)` rather than averaged, and query or page rows will not sum to the daily totals. The [warehouse marts](#warehouse-marts) build these rules into the columns an agent reads.

#### Projection

- `ApiDataRow.keys` is **positional** against requested `dimensions`; the API never names the columns. A row whose key count disagrees with the request is skipped rather than failing the copy.
- `clicks`, `impressions` and `ctr` are always present, zeros included (live Discover rows report `"clicks":0,"impressions":0,"ctr":0`). `clicks` and `impressions` are integers; a missing or fractional count fails validation.
- Dated grains carry `settled`: false from the page's `firstIncompleteDate` on, while Google may still restate the day. The next incremental run re-reads it and the flag turns true once Google settles it.
- `position` is **nullable**, and absent for a different reason: Discover and Google News report no rank at all, on every row including zero-traffic ones. Loading a missing rank as `0` would claim the best possible position. Verified live: all 380 Discover and all 380 Google News daily rows carry no position.
- Sitemap `warnings`/`errors`/`submitted` are `string/int64` → parsed to integer, non-safe integers rejected.
- `date` is a **PST calendar date**, not an instant (`format: 'date'`).
- The 16-month history window is calendar arithmetic clamped to the end of a shorter month: sixteen months before 31 March is 30 November. Counting 480 days instead drifts by roughly a week and silently drops history.

The report types change which rows exist, so they are part of the source identity (`search-console:<searchTypes>`); the properties are partitions, not identity. The window is not: it moves with the clock, and state resumes it.

### Incremental search analytics

Google revises recent metrics for roughly two to three days. The response metadata reports `firstIncompleteDate`, the first day still being collected, so the connector does not guess a lookback:

- State is `{ date: '<last settled day>', diff }`, where `diff` is the [snapshot](#re-read-windows) of the days from that date.
- A run resumes **at** the saved date rather than after it, so the last settled day is re-read. That re-read is the lookback.
- Requests use `dataState: 'ALL'`, and the checkpoint advances to `firstIncompleteDate` minus one day, or to the end date when the API reports none.
- Rows are paginated by `startRow` at 25000 per page until a short page.
- Each read is diffed with the last, keeping only the days from the next start. A restated row loads again, an unchanged one is not rewritten, and a row Google no longer returns for a re-read day is deleted, including every row of a day that comes back empty. Days before the window stay as loaded.

`searchAnalyticsDaily` requests one window per report type and keeps the earliest settled boundary across them, because report types settle independently.

### Warehouse marts

The Google app loads into the PostgreSQL warehouse and installs a shared metadata contract. Each source publishes its own content views in `marts`, named after the source. The layout:

```text
warehouse database
├── google_search_console   raw tables and _elt_checkpoints, loaded by elt-postgresql; readers have no access
├── _warehouse              private sync attempts and coverage declarations
├── marts                   documented reader views, one prefix per source
└── public                  revoked from PUBLIC
roles: warehouse (loads, owns the database) · agent_reader (reads marts only)
```

- **Privileges are the barrier.** `agent_reader` has `CONNECT`, `USAGE` on `marts` and `SELECT` on its relations, and nothing else. It has no `TEMP`, no `CREATE`, and no access to raw schemas. Views run with their owner's rights. The role's settings (`default_transaction_read_only`, `statement_timeout 30s`, `search_path = marts`) are only defaults, since a session may change them.
- **Direct PostgreSQL access works.** Use `psql` as `agent_reader`; MCP is optional. The explicitly invoked `query-warehouse` consumer discovers relations and meanings from `marts.catalog`. It reads connected data only on request and does not run pipelines, refresh data or manage connectors. The existing optional MCP container adds its own SQL restrictions.

The reader's contract is provisioned once, with the database: `infra/init/02-marts.sh` runs `infra/init/marts/contract.sql` in the `warehouse` database. It revokes `PUBLIC` access, gives `agent_reader` `CONNECT` and `USAGE` on `marts`, creates `marts` owned by `warehouse`, publishes `catalog`, and sets default privileges so every table and view the `warehouse` role creates in `marts` is readable by `agent_reader`. No application code grants access. Like every init script, it runs when the volume is first created; to apply a changed contract, recreate the volume with `npx nx run infra:reset`. `installSearchConsoleMarts(sql, { raw })` replaces the Search Console views after extraction, once every Search Console raw table exists; a missing one is named and nothing is replaced. Publication fails if outside views depend on a replaced view; no `CASCADE` is used.

`PostgresSyncHistory({ url })` from `elt-postgresql` is the pipeline's [sync history](#sync-history) for this warehouse. Each pass inserts one `sync_attempts` row, with the connection name as `connector` and the source identity as `source`, and one `extraction_coverage` row per selected stream, with the source's declared `coverage(stream)` and the connection destination's schema as `target_schema`, before it reads; the outcomes close them. A run passes every stream a connection selected; a watch pass reads only the streams its source reported changed, so an attempt vouches only for its own `extraction_coverage` rows. An invalid connection, or a connection whose watcher stopped, records a failed attempt without outcomes. Use the same database for the history and the connection's destination. Google's connector records one run this way.

Every attempt retains its own declarations. `sync_status` gives the latest attempt separately from the most recently completed all-copies-successful attempt. `stream_status` gives the same two facts for each stream, because a watch pass declares only the streams that changed. An unchanged pass advances success even with zero writes. A failed or partial pass keeps earlier success and its original scope available by attempt ID. Per-copy status and failure partitions let a reader distinguish successful streams within a partial attempt. Counts are accepted operations committed during that pass, including deduplication no-ops and deletions of absent keys, not changed-row counts or current totals. A first failure has no successful timestamp.

Coverage is **configured scope**, not observed minimum/maximum dates and not evidence of upstream completeness. Google declarations describe configured properties, report types, history/resume policies and inspection selection; they do not claim that every incremental pass rereads its entire configured history. A successful quota-limited URL inspection pass can leave due URLs pending until Pacific midnight.

Three clocks have different meanings: source record modification fields describe upstream changes; `loaded_at` describes the load that last wrote a row; `last_successful_sync_at` describes recorded pass completion. `search_console_freshness` reports observed dates and maximum row load time only. Neither table timestamps nor sync completion imply that a watcher is healthy. An attempt left `running` means only that completion was not recorded, including after process interruption or failure to persist outcomes. Metadata and destination commits are separate; unfinished metadata never claims success. Credentials/source setup before construction of a pipeline and Google's subsequent mart publication are outside the recorded extraction attempt. Missing metadata means unknown, not empty or current.

| Relation                                                                                                       | Contents                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `catalog`                                                                                                      | Every view, table and column in `marts`, with its description. The agent's starting point.                                                                                                                                             |
| `sync_status`                                                                                                  | Latest attempt and last successful pass completion per connection, each with its attempt ID.                                                                                                                                           |
| `stream_status`                                                                                                | Per connection and stream: the latest attempt that declared the stream with its copy status, and the last attempt in which that copy succeeded. A watch pass reads only changed streams, so judge a stream here, not in `sync_status`. |
| `sync_attempts`                                                                                                | Retained attempt history, start/completion times, status and errors.                                                                                                                                                                   |
| `extraction_coverage`                                                                                          | Per attempt and stream: configured selection, scope explanation, target, copy outcome, committed counts and failed partitions.                                                                                                         |
| `search_console_freshness`                                                                                     | Observed latest day, settled day and maximum row `loaded_at` per Search Console view, computed when read. Not sync status.                                                                                                             |
| `search_console_totals_daily`                                                                                  | Authoritative totals per property, day and report type.                                                                                                                                                                                |
| `search_console_queries_daily`, `search_console_pages_daily`                                                   | Web breakdowns. Pages add `page_path`. Rows a re-read no longer returns are deleted when it loads.                                                                                                                                     |
| `search_console_withheld_daily`                                                                                | Web totals, the sum of query rows, and the difference Google withheld.                                                                                                                                                                 |
| `search_console_countries`                                                                                     | The trailing country × device window with its `start_date` and `end_date`.                                                                                                                                                             |
| `search_console_properties`, `_sitemaps`, `_sitemap_contents`, `_url_inspection` (+ `_sitemaps`, `_referrers`) | The listings, in snake_case. Inspection adds `page_path`.                                                                                                                                                                              |

Measures are additive only. The views carry `clicks`, `impressions`, `ranked_impressions` (impressions that had a rank) and `position_weight` (rank × impressions), and no per-row `ctr` or `position`. The only rates an agent can express are the correct ones: `sum(clicks)::float / nullif(sum(impressions), 0)` and `sum(position_weight) / nullif(sum(ranked_impressions), 0)`. Column descriptions state both. Dates are Pacific Time calendar days, and `settled` marks days Google may still restate.

Verified on 2026-09-24 against Postgres 18.3, first on a local Homebrew server. The tests load a fake Search Console through the real pipeline, install marts, and read as a fresh reader role. A separate run as the non-superuser `warehouse` and `agent_reader` roles, reading through `postgres-mcp` 0.3.0 in restricted mode, confirmed four things:

- The documented rate formulas return the expected values.
- Raw schemas answer `permission denied`.
- `COMMIT; CREATE TABLE …` fails validation.
- A three-billion-row count is cancelled after 30 seconds.

The compose stack was then started on Docker Desktop 4.92.0. The init script created both roles and the database, `elt-postgresql` tests passed against it, and the MCP container answered as `agent_reader` with `search_path` `marts`: it refused `pg_authid`, rejected a `COMMIT;` escape, and cancelled a long count at 30 seconds. A live load of `sc-domain:ezz.sh` into the compose warehouse then filled every view. Read as `agent_reader`, the observed-row freshness then showed data through 2026-09-24, settled through 2026-09-21, and `search_console_withheld_daily` showed Google withholding 1–2 clicks a day from the query rows.

### URL inspection and quota

URL inspection has no listing endpoint: each row costs one request naming one URL, against 2000 per day and 600 per minute for a property. The connector inspects every URL it can know about for a property:

- **Discovery.** Every URL listed by every sitemap the property has (`sitemaps.list`), fetched from the site: XML url sets, sitemap indexes (followed up to 3 levels), RSS 2.0 and Atom feeds, plain-text lists, gzipped or not. Plus every page in the full 16-month search analytics history, for each configured report type. `#fragments` are stripped (Google Search indexes documents, not anchors), duplicates merge, and only URLs under the property are kept. A page that is in no sitemap and never appeared in search cannot be discovered through any Google API.
- **Rolling refresh.** Each URL's last inspection time is kept in the stream's checkpoint. A run inspects never-inspected URLs first, then any whose last inspection is older than `inspectionRefreshHours` (default 24), stalest first; fresher URLs cost nothing. A property with more URLs than the daily quota is covered over successive days: each URL is refreshed about every ⌈URLs / 2000⌉ days.
- **Concurrency.** `inspectionConcurrency` (default 16) requests run at once, paced under 600 starts per minute, so a quota refusal can only mean the daily quota. Live, 126 URLs took 54 seconds where one-at-a-time took about 6.6 seconds per URL.
- **Quota.** When Google refuses for quota (a `429` that outlasts the retries), no new request starts, the ones in flight finish, and the inspections that succeeded are committed. The source makes no further inspection request for that property until the next midnight Pacific time, when per-day Google Cloud quotas reset.
- **Rejected URLs.** A `400` or `404` for one URL is loaded as a `urlInspection` row with `errorStatus` and `errorMessage` and null verdicts, and the run continues. A `401` or any other `403` would fail every URL alike, so it fails the copy.
- **Removal.** A URL that leaves the discovered set is deleted from all three tables; an array that shrank loses its extra positions.
- **Sharing.** One request serves all three streams: the source keeps its inspections in memory, and a stream uses one newer than what it last loaded before calling the API. The source reads `streamConcurrency` (default 4) streams at once, so the three inspection streams can run together; they take turns per property to plan and inspect, so a stream sees what the one before it inspected and no URL is inspected twice, while different properties never wait on each other.
- **Unreadable sitemaps** do not stop inspection. Each listed sitemap's outcome is loaded on the `sitemaps` stream (`urlsRead`, `readError`), and the URLs every other source shows are still inspected. Live, `https://ezz.sh/sitemap.xml` resets TLS connections, and Google itself last read it on 2025-07-20 with one error.

### Retry

Every Search Console call retries rate limits and transient server errors, then gives up loudly. Search Console allows 1200 queries per minute per site per user, and 40000 per minute and 30000000 per day per project.

| Response                                                         | Retried | When retries run out                                    |
| ---------------------------------------------------------------- | ------- | ------------------------------------------------------- |
| `429`                                                            | Yes     | `SearchConsoleQuotaError`, with `status` and `attempts` |
| `403` with reason `rateLimitExceeded` or `userRateLimitExceeded` | Yes     | `SearchConsoleQuotaError`                               |
| Any other `403` (insufficient scope, disabled API)               | No      | The original error, unchanged                           |
| `408`, `500`, `502`, `503`, `504`                                | Yes     | The original error, unchanged                           |
| Anything else                                                    | No      | The original error, unchanged                           |

The wait honors the server's `Retry-After`, in seconds or as an HTTP date. Without one, it doubles per attempt from `baseDelayMs` with full jitter, capped at `maxDelayMs`. A `Retry-After` longer than `maxDelayMs` fails at once instead of stalling the pipeline. The default policy is five attempts, one second base, one minute ceiling; pass `retry: { attempts, baseDelayMs, maxDelayMs }` to `SearchConsoleSource` to change it.

google-auth-library's transport, gaxios, has its own retry, but it is off by default, excludes `POST` (which `searchAnalytics.query` and URL inspection both use), and never reads `Retry-After`. The retry therefore lives in `SearchConsoleApi`, over the library-agnostic `GoogleRequester`.

### Watching

Search Console publishes no change notification. `watch()` polls every `pollIntervalMs` (default six hours) and first reads a cheap summary grouped by `date`, invalidating the analytics and listing streams only when `firstIncompleteDate` moved or a day's clicks or impressions changed. A restatement that leaves daily totals identical while reshuffling the per-query breakdown is not detected by this probe.

Inspections do not follow traffic. The source decides when they are due: it learns each URL's last inspection from the checkpoints its own extractions receive, and wakes only the inspection streams when the next URL falls due (or at the Pacific-midnight quota reset). Selecting only inspection streams never probes analytics. An app that calls `run()` and exits has no watcher; schedule it with the operating system (cron, launchd) and each run inspects whatever is due.

A property whose probe fails, for example after its permission was revoked, does not end the watch: the failure becomes part of that property's fingerprint, so when it starts or stops failing, the streams are invalidated and the extraction reports it or loads it, while the other properties keep being watched.

Aborting the watch signal cancels the probe's request and any `Retry-After` wait at once, so closing never sits out a rate-limit delay. The cancellation surfaces as the signal's `AbortError`, not the transport's wrapped error.

### Verified and unverified

Stream projection, positional key mapping, pagination, incremental checkpointing, restatement replacement, inspection batch sharing, watch gating, retry and abort behavior, the loopback consent flow, and grant reuse and re-consent are covered by tests using controlled API responses.

Live verification on **2026-09-22** ran the pipeline twice against a real property (`sc-domain:ezz.sh`) into SQLite, over `google-auth-library` 11.1.0 and Node.js 26.8.1:

- All seven streams loaded: 4 sites, 1 sitemap, 1 sitemap content row, 7736 analytics rows spanning 2025-07-21 to 2026-09-22, 9 inspected URLs, and 12 referrer rows.
- The API reported `firstIncompleteDate: 2026-09-21`, and the checkpoint stopped at `2026-09-20`.
- The second run extracted 135 rows rather than 7736, resuming at the checkpoint instead of re-reading the backfill window.
- Row count and distinct key count both stayed at 7736, so the re-read days replaced their rows instead of duplicating them. `loaded_at` on 2026-09-20 through 2026-09-22 advanced to the second run while 2026-09-19 kept the first run's value, which is the replacement the default `cursor_newer` guard would have skipped.

A second live run on the four-grain structure loaded 2280 daily rows across six report types, 3525 query rows, 1508 page rows and 261 country rows. All 380 Discover and all 380 Google News daily rows carried a null position, and the daily totals reproduced a standalone date-only request exactly (58 clicks, 1986 impressions for 2026-09-10 to 2026-09-20) where the former single wide stream saw 37 and 1020.

Live verification on **2026-09-24** repeated it over the loopback consent flow, since the runs above used the since-removed gcloud credential. The client was an existing Desktop-type OAuth client in the same Cloud project as the API:

- The first run found no grant, opened Google consent, stored the grant as owner-only files (`0700` directories, `0600` JSON, hashed names), then loaded all ten streams, resuming the analytics grains from the earlier checkpoint.
- The second run reused the stored grant with no browser and finished in 80 seconds. It re-read three days (18 daily rows across six report types) from the `2026-09-21` checkpoint.
- Every analytics table kept row count equal to distinct key count (2286 daily, 3571 query, 1514 page rows), so the re-read days replaced their rows.

Live verification on **2026-09-24** of the daily inspection quota on `sc-domain:limerence.sh`: 1868 inspections succeeded after 132 earlier that day (2000 in all), then Google answered `429` with reason `rateLimitExceeded`, status `RESOURCE_EXHAUSTED`, message "Quota exceeded for sc-domain:limerence.sh." and no `Retry-After`, not the `403 quotaExceeded` its error reference lists. The pool stopped with every earlier inspection kept, and a further call reported the quota exhausted without inspecting anything.

Live verification on **2026-09-24** of partitions: one source listing `sc-domain:ezz.sh`, `sc-domain:january.sh` and `sc-domain:limerence.sh` loaded every table in one run, with one checkpoint per stream holding a `{ partitions: [...] }` entry per property.

Live verification on **2026-09-25** of target ownership against `sc-domain:ezz.sh`: after the old `_elt_writers` table was dropped, one run recreated it as `(target, writer)` with one row per table, each owned by its copy id (for example `sitemaps ← {"copy":"sitemaps"}`). A second copy from another source into `sitemaps` failed with `TargetOwnedError` naming both writers, extracted nothing, and left its row count unchanged.

Live verification on **2026-09-25** of failure isolation and clear, against `sc-domain:ezz.sh`:

- A run listing `sc-domain:ezz.sh` and `sc-domain:example.com` (no permission) ran every stream. `ezz.sh` loaded and checkpointed (for example 24 daily and 78 query rows), each partitioned stream reported `example.com` with Google's "User does not have sufficient permission for site 'sc-domain:example.com'", the run failed, and no `example.com` row or checkpoint entry was written. The next run with `ezz.sh` alone completed.
- `watch()` over the same two properties stayed open: its first batch loaded `ezz.sh` (18 daily rows) and reported `example.com` with the same permission message, where the property's failing probe used to end the watch before any load.
- Clearing the `sitemaps` copy emptied its table, owner row and checkpoint while `marts.search_console_sitemaps`, a view on it, kept working; the next run reloaded it from scratch. Dropping the table instead is refused by Postgres because of that view, which is why clear empties SQL tables.

Not exercised live: `watch()` over a real polling interval, Markdown destinations, a property large enough to page past 25000 rows, and the quota ceiling on URL inspection.

### Row ceiling

Two limits apply, and only one loses data. A request returns at most 25000 rows; the connector pages past that with `startRow`, so nothing is lost. Separately, Google keeps at most 50000 rows per day per report type for a property and states the API "does not guarantee to return all data rows"; beyond that, rows are dropped with no signal. This is documented by Google, not observed: the live property's busiest day had 39 query rows.

## SQL Server

`SqlServerSource` reads one SQL Server database: every user table its login can read becomes a stream named `<schema>.<table>`. The streams are the database's own tables, so the source is discovered, and a host discovers it again on every run; a table whose columns changed reaches the pipeline as a changed stream, which [starts its copy over](#checkpoint-stores). `sqlServerCopies` makes each stream a copy: an incremental `append_dedup` copy for a stream that reads changes, a full-refresh `overwrite` for one that reads every row.

```ts
import { SqlServerDatabase } from '@workspace/sdk-microsoft-sql-server';
import { sqlServerCopies } from '@workspace/source-microsoft-sql-server/sql-server-copies';
import { SqlServerSource } from '@workspace/source-microsoft-sql-server/sql-server-source';

const database = new SqlServerDatabase(
  'Server=sql.example.com,1433;Database=shop;User Id=reader;Password=...;Encrypt=true',
);
const source = await SqlServerSource.discover(database, { schemas: ['dbo'] });
const steps = sqlServerCopies(source, (stream) => destination.table(stream));
```

`@workspace/sdk-microsoft-sql-server` owns the database: the ADO.NET connection string, which [mssql](https://github.com/tediousjs/node-mssql) parses (it reads no `mssql://` URL), discovery, exact reads, Change Tracking and the change signal. The source owns the streams, their schemas and the sync strategy. SQL Server 2016 or later is required, or Azure SQL Database or Managed Instance.

### Access

A read-only login is enough: `db_datareader`, plus `VIEW CHANGE TRACKING` on each tracked table whose changes and deletions it should read. Nothing has to be enabled on the server. The source uses Change Tracking and snapshot isolation where an administrator turned them on, and reads every other table in full or by its rowversion. A connection string that names no `Database` is refused, so a read never lands in the login's default database. A server that cannot be opened fails with `SqlServerUnavailableError`, naming the server and database but never the credentials.

A column the login cannot read (a column-level `DENY`) is left out, and the table's description names it; a primary key with such a column identifies nothing, so its table reads in full. A table with no readable column is not a stream. A grant revoked after discovery fails only that table's stream, with `SqlServerPermissionError` naming the grant (`SELECT ON [dbo].[orders]`, `VIEW CHANGE TRACKING ON [dbo].[orders]`). Columns under dynamic data masking load as the login reads them, masked unless it holds `UNMASK`, and their description says so.

### Streams

Discovery lists `sys.tables`: user tables, not views, not system or external tables, and not the change tables CDC keeps in `cdc`. A host can keep only some schemas (`{ schemas }`), named exactly as `sys.schemas` spells them; a schema named there that holds no table the login can read fails discovery, so a misspelling, a casing the database does not use, or a missing grant never loads less in silence. A column of an alias type (`CREATE TYPE ... FROM nvarchar(20)`) reads as the system type it is built on, even when the login cannot see the alias type. The stream key is the table's primary key in key order, plus the `_type` sibling of a `sql_variant` key column. Descriptions come from `MS_Description` extended properties, or are generated from the column's name and type; the table's description also says how the stream reads it and which grant would read only changes.

| SQL Server                                                                                 | Field                                                                                                               |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `tinyint`, `smallint`, `int`                                                               | `integer`                                                                                                           |
| `bigint`, `rowversion`                                                                     | `int64`                                                                                                             |
| `bit`                                                                                      | `boolean`                                                                                                           |
| `real`, `float`                                                                            | `number` (the IEEE value, exactly)                                                                                  |
| `decimal(p, s)`, `numeric(p, s)`                                                           | `decimal`, precision `p`, scale `s`                                                                                 |
| `money`, `smallmoney`                                                                      | `decimal` (19, 4) and (10, 4)                                                                                       |
| `date`                                                                                     | `date`                                                                                                              |
| `datetime2(p)`, `datetime`, `smalldatetime`                                                | `date-time-local`, precision `p`, 3 and 0                                                                           |
| `datetimeoffset(p)`                                                                        | `date-time`, precision `p`: the UTC instant; beside it `<column>_offset`, the offset it was written with in minutes |
| `time(p)`                                                                                  | `time-local`, precision `p`                                                                                         |
| `char`, `varchar`, `nchar`, `nvarchar`, `text`, `ntext`, `xml`, `uniqueidentifier`, `json` | `string` (a uniqueidentifier in upper case)                                                                         |
| `hierarchyid`                                                                              | `string`, its path (`/1/2/`)                                                                                        |
| `geography`, `geometry`                                                                    | `string`, `SRID=<id>;` then the shape as text with its Z and M (`SRID=4326;POINT (-122.349 47.651 10 3)`)           |
| `sql_variant`                                                                              | `string`, the value as text; beside it `<column>_type`, its base type                                               |
| `binary`, `varbinary`, `image`, CLR types                                                  | `string`, base64                                                                                                    |

The driver hands `decimal` and `money` over as JavaScript numbers, `datetime2` as a millisecond `Date`, and drops a `datetimeoffset`'s offset, so every such column is selected as the text SQL Server spells it and decoded into its canonical form. When a column of the table already has the name `<column>_offset` or `<column>_type`, the added field gets the next free name: `_1` follows, then `_2`. The column's description names the field that holds its offset.

### Sync strategies

Each table reads the first way it can, decided at discovery:

- **Change Tracking**, for a keyed table that tracks changes when the login holds `VIEW CHANGE TRACKING`. The first read loads every row, 10,000 rows per checkpoint in primary key order, from the position in the table's change history read before it began; a load that fails resumes after its last checkpoint. Later reads apply each key that changed since: its row as it is now, or a `DELETE`. With `ALLOW_SNAPSHOT_ISOLATION` on, the position, the check and the changes come from one short snapshot transaction per table; without it, the position is read first, so a change made during the read is read again next time, and the history is checked again after the read.
- **Rowversion**, for a keyed table with a `rowversion` column: each read takes the rows above the last rowversion it read and below `MIN_ACTIVE_ROWVERSION()`, so a row still being written waits for a later read. Deletions are not seen; a deleted row stays loaded. Its state records the columns it read: a column the table gained bumps no rowversion, so the next read starts again from the first row, keeping what is loaded.
- **Full refresh** for everything else: every read takes every row and the copy replaces its target.

A position in a table's change history is a Change Tracking version and the table's tracking generation: its `begin_version`, which a `TRUNCATE` moves to the current version, and the creation time of its change table, which re-enabling tracking renews. When the saved position is below the table's minimum valid version, ahead of the database's current version, or of another generation, the history no longer covers it: the stream sends `RESET` and loads every row again into a [hidden target](#resets) that replaces the table when the stream ends. It does the same for a column the table gained since its state was saved, since Change Tracking reports no change for the rows it was added to. The generation catches the case the minimum valid version cannot: a truncate right after a sync, with nothing changed in between, leaves the minimum valid version equal to the saved one.

Pages compare the whole primary key as a tuple, each part cast to its column's declared type and collation, so a page neither skips nor repeats rows that share a leading key value, and a `varchar` key under a SQL collation orders as the column sorts.

### Watching

`observe()` polls every 30 seconds: a moved Change Tracking version (`CHANGE_TRACKING_CURRENT_VERSION()`) wakes the Change Tracking streams, a moved last rowversion (`@@DBTS`) the rowversion streams. Full-refresh streams have no change signal a read-only login can see, and refresh once an hour.

### SQL Server host

`apps/sql-server` lists the databases to load in `connectors.ts`; each reads `SQLSERVER_<NAME>_CONNECTION_STRING` from the workspace `.env`. A database loads into its own raw schema, `sql_server_<name>`, with its checkpoints, and each table gets its name from the [naming rule](#names) (`dbo.Order Items` becomes `dbo_Order_Items_<hash>`). Readers see each table as `marts.<name>_<schema>_<table>` in snake case; a name the snake case changes keeps a hash of the original (`local_sales_order_items_80f28272`). Two tables that still land on one view name, such as `dbo_order.items` and `dbo.order_items`, do not merge: the second's load refuses the view the first made. Column names follow the same rule. They keep their case, so a mixed-case column is quoted (`"orderId"`), and the description of a renamed column names the SQL Server column. A table dropped upstream leaves its raw table and view as they were.

### SQL Server limitations

- Rowversion tables never see deletions; CDC is not read.
- A truncate, or tracking turned off and on, goes unnoticed in one case: when the table's tracking began at the very version the last sync read and nothing tracked changed anywhere in the database since. No metadata a read-only login can see changes then.
- A single value larger than JavaScript's longest string (about 512 million characters) fails its stream.

### SQL Server live checks

Run on 2026-10-06 against SQL Server 2022 CU27 (16.0.4295.3) Developer, in the compose `sqlserver` service on linux/amd64, emulated on Apple silicon, through mssql 12.7.4 and tedious 20.3.3:

- Style 126 leaves out a zero fraction (`2025-01-02T03:04:05`) and keeps every digit of any other (`.1200000`); `time(p)` keeps exactly `p` digits; style 2 spells money with four.
- `CHANGE_TRACKING_MIN_VALID_VERSION` returns 0, not NULL, to a login without `VIEW CHANGE TRACKING`, whose `CHANGETABLE` read fails with error 229; `sys.change_tracking_tables` and `MS_Description` stay visible to `db_datareader`.
- `TRUNCATE` sets the table's minimum valid version and `begin_version` to the current version; re-enabling tracking renews the change table's `create_date` in `sys.internal_tables`, which `VIEW CHANGE TRACKING` makes visible.
- A column-level `DENY` makes `HAS_PERMS_BY_NAME` report the whole table unreadable, so readability is checked per column; a column of an alias type the login cannot see disappears from an inner join with `sys.types`.
- A key bound as an `nvarchar` parameter and compared with a `varchar` column under `SQL_Latin1_General_CP1_CI_AS` skips rows (`co-op` before `Coat`): the two sort hyphens differently.
- `varbinary` keys ignore trailing zero bytes (`0x00`, `0x0000` and `0x` are one key).
- tedious 20.0.0 refused to connect to an IP address over TLS; 20.3.3 connects.
- `sql_variant` text under style 126 keeps times exact; floating point needs style 3 for 17 digits.
- An end-to-end run of `nx run sql-server:start` loaded a seeded database read by a `db_datareader` login, wrote nothing to its Change Tracking and rowversion tables on a second run, and applied an update, a deletion, a truncate and an added column on a third.
