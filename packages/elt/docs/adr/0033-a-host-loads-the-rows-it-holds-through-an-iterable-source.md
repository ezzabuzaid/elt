# A host loads the rows it holds through an IterableSource

A host that holds rows in its own memory or store had to write a `Source` subclass to load them: `identity`, `catalog`, `coverage`, `currentAsOf`, `open`, `changeSignals` and `extract`. That was about 40 lines for 12 rows in the probe of 2026-11-22 for the Terminal-Bench 2 explorer (April #5407). Eleven test classes in ten files of elt write the same source, and the Terminal-Bench 2 explorer and agent-backlog would write it again (elt #5402).

The leaders take the rows directly. dlt takes "any Iterator or Iterable" in `pipeline.run(data)`. LangChain takes `index(Iterable[Document])`. LlamaIndex takes `IngestionPipeline.run(documents=...)`. Pekko's `Source.fromIterator` takes a function, because "the iterator will be created anew for each materialization". elt already has each part that such a source needs: a `Stream`, `diffSnapshot`, the sync modes, the checkpoint store and change signals. One class puts them together.

## Decision

`IterableSource` is a `Source` in `@eltjs/elt`, exported beside `diffSnapshot` (Ezz, 2026-11-24, "They stand"). A host gives an `identity` and its streams:

```ts
const source = new IterableSource({
  identity: 'tasks',
  streams: {
    tasks: {
      description: 'Each task that the host holds now.',
      jsonSchema, // declared, not inferred
      primaryKey: ['name'], // one field or more
      deletions: 'closed-world', // omitted: a row that the host stops giving stays
      snapshot: ({ signal }) => tasks, // Iterable or AsyncIterable, once for each pass
    },
  },
});
source.streams.tasks; // the frozen Stream for a Copy
source.changed(source.streams.tasks); // tells a watch that the rows changed
```

- **A factory for each pass, no buffer.** Each pass calls `snapshot({ signal })` one time and pulls the rows as the destination asks for them. The host stays the upstream: a pass that fails reads the rows again from the host. `signal` is the signal of the run.
- **The host writes no flags.** The built `Stream` supports `full_refresh` and `incremental`, declares `sourceDefinedCursor`, and declares `emitsDeletes` only with `deletions: 'closed-world'`. Thus a host cannot declare deletions with no deletion policy.
- **No cleanup option.** The sync modes of the copy and `deletions` are the cleanup modes of LangChain (`None`, `full`) and LlamaIndex (`UPSERTS`, `UPSERTS_AND_DELETE`).
- **A repeated key fails the read in both sync modes.** `diffSnapshot` checks keys only in an incremental copy. In a full refresh it gives each row, and `overwrite_dedup` kept the last row with no error (probe P1, 2026-11-24). Thus `IterableSource` checks the keys of a full refresh itself, with the same message: `Snapshot <stream> returned <key> twice in one scan` (ADR 0022).
- **Content hash, or the version of the host.** An incremental copy compares the SHA-256 of each row. A stream that names `rowVersion` compares the value of that column in place of the hash (dlt `row_version_column_name`). A row whose version did not change is not read again, also when its content changed. The column must be in `jsonSchema`.
- **Watch.** `changed(stream)` raises a revision that a gauge of the stream reads, once a second by default. A host whose store it can watch also gives `changeSignal: { gauge, interval, timeout }`; `gauge` is a function, because the pipeline disposes each gauge when its watch stops (ADR 0020).
- **Coverage** is the `description` of the stream, with no selection. `currentAsOf` is null unless the stream gives one (ADR 0014). `configErrors` is an option of the source; other errors are `system` (ADR 0012).
- **Kinds.** The declaration of a stream is a union of kinds. This decision adds the `snapshot` kind: the host gives every row that it holds at each pass. The `changes` kind (the rows after a saved version, with `cursorField` and tombstones) is the next member of the union, with no flag.

## Precedents

- **dlt** evaluates `data` inside `run`, takes a `row_version_column_name`, and replaces or merges by the write disposition, not by an option of the data.
- **LangChain** `index` and **LlamaIndex** `IngestionPipeline` compare a hash of each document with the hashes of the last run, and delete what a full run did not list.
- **Haystack** `DuplicatePolicy.FAIL` fails a write that repeats an id.

## Considered Options

- **A push queue: `source.push(rows)`, which the next pass drains** (Spark `MemoryStream`, Pekko `Source.queue`). A row that the host gave but no commit took lives only in memory, and a crash loses it while the host believes that it gave it. Pekko deprecated its queue with backpressure because it deadlocked.
- **A mutable property: `source.rows = [...]`**, as the test sources did. It holds the array between passes and has no async iterable and no signal.
- **A source package, `@eltjs/source-iterable`.** The source has no upstream and no SDK; it uses only core. Destination tests would take a dependency on a source package for a core concept.
- **A factory for each pass in core.** This option was selected.

## Consequences

- A host loads rows in a few lines. The test sources of elt move onto `IterableSource` (#5402).
- A snapshot of a large set holds a key and a hash for each row in the checkpoint: about 55 bytes a row, 301,407 bytes for 5,500 rows (probe P8). A scan in parts (`continues`) is not exposed yet.
- A `rowVersion` that misses a change keeps the old content of the row, with no error.
- The probes of 2026-11-24 ran with a `Source` subclass of the same shape: P2 (an unchanged push writes no row on SQLite, Postgres and SQL Server 2025), P3 (a closed-world delete in both modes) and P4 (a throw ends `failed`, an abort ends `cancelled`, and nothing is deleted). The tests of `IterableSource` in elt-sqlite, elt-postgresql and elt-sqlserver run them on the class itself.

## Amendment 2026-11-24: the changes kind

The `changes` kind is the second member of the union (#5402 D5, ruled by Ezz on 2026-11-24, "They stand"). A stream has `snapshot` or `changes`, never both, and only `changes` has `cursorField` and `ordered`:

```ts
tasks: {
  description: 'The tasks that changed after a version.',
  jsonSchema, // declares cursorField, and no property deleted
  primaryKey: ['name'],
  cursorField: 'version',
  ordered: true, // optional: the host gives the changes in version order
  changes: ({ since, signal }) => log.after(since), // rows, and { deleted: key, version }
},
```

- **The built `Stream` has a cursor field.** It supports `full_refresh` and `incremental`, declares `emitsDeletes`, and does not declare `sourceDefinedCursor`. With `sourceDefinedCursor`, a copy refuses `cursorField`, and without a cursor field it refuses `cursor_newer` (probe P7). The `Stream` declares `defaultCursorField: [cursorField]`, which this amendment adds to elt's `Stream` (Airbyte's `default_cursor_field`, a path of one property). An incremental or `cursor_newer` copy that gives no `cursorField` compares it, so the host names `cursorField` once. A stream with `sourceDefinedCursor` refuses a `defaultCursorField`. `IterableSource.validateExtraction` refuses each copy that does not deduplicate with `cursor_newer` on the declared `cursorField`, before the run reads. Thus a copy cannot compare another field.
- **A tombstone is a deletion at its version.** `{ deleted: key, version }` becomes a `DELETE` with `cursor` = `version` (ADR 0032). A tombstone older than the stored row deletes nothing, and a row older than the stored row changes nothing. Because a tombstone is the change that holds `deleted`, the constructor refuses a `jsonSchema` that declares a property `deleted`.
- **State is the version.** The state is `{ since }`, and the next pass gives `since` to `changes`. Without `ordered`, a pass saves one state at its end, with the greatest version that it gave (D9). A pass whose checkpoint did not save gives the same `since` again; the replay changes no row (probe P7a).
- **`ordered: true` is checked in `IterableSource`.** Core saves a state that goes back (probe P7c). An ordered pass fails the stream at a version below the version before it, with a message that names both versions. It saves when the version rises, with the version before, not after each row: `since` means "the changes after this version", so a state saved after the first of two changes at version 5 would skip the second one at the next pass. Changes that share a version thus save together. dlt keeps the same boundary rows for the same reason: its `incremental` starts at `start_value` inclusively and removes the rows of that value that it already loaded.
- **Versions compare as the destinations compare them** (`FieldFormat.ordering`): numbers by value, `int64` text as integers, and other text by byte order. The type of `since` and of the `version` of a tombstone is the type of the cursor field: the declaration is a union with one member for each property whose values are text or numbers, keyed by `cursorField`. `changes` is a method, so a declaration typed for its own cursor field is also a declaration of any schema.

Consequence: a host with a version gives only its changes, and a host without one gives a snapshot (D5: a delta push with no version cannot resume).
