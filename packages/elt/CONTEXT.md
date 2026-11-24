# elt

A user wants the data of their apps and services in one store that SQL can read. elt copies that data: a source reads an upstream, and a destination keeps each stream as a table. The pipeline starts the copies. It also keeps derived datasets in step with what the copies load, for example the text of each stored file.

## Language

**Source**:
The code that reads one upstream and gives its streams.
_Avoid_: Connector (a host sets up connectors), provider, integration

**Upstream**:
The system that a source reads, for example the store of an app, an API or a database.
_Avoid_: Origin (a web source uses origin for a website), backend

**Destination**:
The store that keeps what the copies load, for example one SQLite file.
_Avoid_: Sink, warehouse (eca uses warehouse for the data its conditions read), target (a target is one table of a destination)

**Copy**:
One stream of a source into one target of a destination.
_Avoid_: Sync, job, replication

**Connection**:
The copies of one source into one destination, with the checkpoints that resume them, as Airbyte's connection is.
_Avoid_: Integration, pipeline

**Pipeline**:
The orchestrator of one or more connections. It starts the passes, and it keeps each derived dataset in step with what they load.
_Avoid_: Job, DAG, workflow

**Pass**:
One read of a connection over the copies that it selected, and what each copy loaded.
_Avoid_: Sync, run (a run has one pass of each connection), batch

**Run**:
One call of `pipeline.run()`: one pass of each connection, with refreshes in the background at each commit, then one more refresh of each derived dataset.
_Avoid_: Sync, execution

**Watch**:
One call of `pipeline.watch()`: a pass each time that a source tells of a change, until the signal aborts.
_Avoid_: Subscription, daemon, poll

**Watch event**:
What a watch gives to its host, of one of two kinds: a pass (`kind: 'pass'`), or a dataset failure (`kind: 'refresh'`). The type is `WatchEvent`, and a host narrows it on `kind`.
_Avoid_: Message, notification, update

**Clock**:
The source of the time and the timers of a pipeline. The caller gives it to the pipeline: an app gives `globalThis`, and a test gives a fake clock that the test moves. The pipeline gives it to its sources and its destination on each call.
_Avoid_: Timer (a timer is one wait that the clock starts), scheduler, time provider

**Commit**:
Rows that a destination made durable. A pass can make many commits.
_Avoid_: Save, write, flush

**Position**:
`<epoch>:<number>`: the last commit of a closed load, when no other load has commits before and after it. A load is a pass of a connection or a refresh of a derived dataset. A reader at a position sees no part of a pass.
_Avoid_: Offset, cursor (eca keeps a cursor), checkpoint

**Epoch**:
The id that names the numbering of a destination's store. A store that is made again has a new epoch, and its numbers start again.
_Avoid_: Generation, version

**Numbering**:
The commit numbers of a store as one snapshot reads them: the epoch, `min_valid` (the oldest position that a reading reads exactly), the high-water mark, and the positions between them.
_Avoid_: Version (a version is a row of a table or of its history), log

**High-water mark**:
The highest commit number at or below which each number is a commit that the snapshot sees, or one that rolled back. A store that writes one transaction at a time has its newest commit as its mark.
_Avoid_: Newest commit (in a store that commits in parallel, a commit with a higher number can end first), watermark

**Host**:
The program that makes a pipeline and starts its runs or its watch, for example the CLI of Context Compiler.
_Avoid_: App (in Context Compiler, an app is a macOS application), runner

**Stream**:
One kind of record that a source gives, with its schema, key and declarations, for example the notes of Apple Notes.
_Avoid_: Table (a table is a target), collection, entity

**Target**:
The stored object of a destination that one copy loads, for example one table.
_Avoid_: Sink, table (a target of a different destination can be a file)

**Writer**:
The copy that owns a target: its `id`, or the source identity and the stream name for a copy with no `id`. A target has one writer.
_Avoid_: Owner claim, producer

**Checkpoint**:
The state of a source that a copy saved after the rows before it committed. The next pass resumes from it.
_Avoid_: Cursor (a cursor is one field of a record), bookmark, offset

**Checkpoint store**:
The store that keeps the checkpoint of each incremental copy and its binding, for example `SQLiteCheckpointStore`. It belongs to the orchestration, not to the destination.
_Avoid_: State file, state backend

**Binding**:
What a checkpoint belongs to: the source identity, the location of the target, the configuration of the copy, and the shape of the stream. A changed binding fails the copy.
_Avoid_: Fingerprint (a fingerprint names a record or a group), signature

**Shape**:
The fields of a stream with their types, and its declarations. The descriptions are not part of it.
_Avoid_: Schema version

**Evolve**:
The destination changes a stored target in place to the new fields of its stream, and keeps its rows.
_Avoid_: Migrate, rebuild

**Reload**:
A stream starts again in a hidden target. The hidden target takes the place of the target when the stream ends with no failure.
_Avoid_: Refresh (a refresh is for a derived dataset), backfill

**Snapshot stream**:
A stream with no change feed whose source compares each complete scan with the snapshot in its checkpoint.
_Avoid_: Full scan stream, polling stream

**Deletion policy**:
The rule that gives each vanished key of a snapshot stream a verdict: deleted, unknown or expired.
_Avoid_: Retention policy (a retention is one kind)

**Iterable source**:
A source whose streams read the rows that the host gives at each pass, as an iterable, with no source subclass of the host.
_Avoid_: Push source (a push source puts rows in a queue, and elt pulls them), memory source, resource (a resource is a stream)

**Partition**:
One part of a stream that a source reads apart, with its own checkpoint, for example one Search Console property.
_Avoid_: Shard, slice

**Read context**:
What a source opens for one read of all the streams of a pass, so that they tell of the same moment, for example a read transaction.
_Avoid_: Session, snapshot (a snapshot is the state of a snapshot stream)

**Check**:
One look of a watch at its upstream. A check that finds no change makes the unchanged streams current as of that check.
_Avoid_: Poll, heartbeat

**Change signal**:
A gauge that a watch reads at each check, the streams that it tells about, and the interval and timeout of its checks. A source declares its change signals, and a failed change signal fails only its streams.
_Avoid_: Probe, watcher, signal (a signal aborts a call)

**Upkeep**:
An action that a source keeps doing while a watch runs, beside its change signals, for example launching Notes hidden so that Notes syncs its store. A change signal only reads the upstream; an upkeep acts on it.
_Avoid_: Heartbeat, keep-alive, task

**Current as of**:
When a stream last agreed with its upstream: the start of its last successful pass or a later check, and never later than when its source says the upstream was last current.
_Avoid_: Freshness, last sync, updated at

**Sync history**:
The record of each pass of a pipeline, its declared coverage and its outcomes, for example `SQLiteSyncHistory`.
_Avoid_: Log, job history

**Coverage**:
What a source says a pass over one stream asks the upstream for, from its configuration. It is the configured scope, not what the pass found.
_Avoid_: Range, completeness

**Failure type**:
Whose a failure is to fix: `config` when only the user can fix it, and `system` for each other failure.
_Avoid_: Error class, severity

**Stored file**:
A copy of a source's file that a copy kept in a file storage, for example `LocalFiles`. A row names it by its ref, and a reader opens it through that storage.
_Avoid_: Attachment (an app's word; a stored file can be any file), blob

**Ref**:
The text that names a stored file in its file storage. Only that storage resolves it: `open(ref)` gives a path, and `head(ref, length)` gives the first bytes. For `LocalFiles`, it is the path of the file relative to its folder. For a database file storage, it is the SHA-256 of the scope, a slash, and the name of the file. In both, the SHA-256 of the bytes and the short source extension name the file.
_Avoid_: Path (a ref is not a path that a reader can open itself), id

**Database file storage**:
A file storage that keeps each stored file in a table of the database of a destination, in chunks of at most 4 MiB, for example the storage that `SQLiteDestination.files()` gives. Its `open(ref)` gives a temporary copy. `DatabaseFiles` is its template class.
_Avoid_: Blob store, file column, chunk table (the chunk tables of `blob().from(file)` were removed)

**Derived dataset**:
Data that the pipeline keeps in step with what its copies load, and that it can always make again from that data (Kleppmann's derived data; Estuary calls it a derivation).
_Avoid_: Materialization (Estuary and Dagster use it for a write to a destination), hook, auxiliary data, view (a view is one kind of derived dataset), index

**View**:
A derived dataset that its store computes on each read, from SQL, as a dbt model that is materialized as a view.
_Avoid_: Reader view (a copy makes a reader view over its own table), materialized view

**Computed dataset**:
A derived dataset that a rule computes on write: one output for each key, as a dbt model that is materialized as a table.
_Avoid_: Cache, index, materialized view

**Refresh**:
The pipeline brings one derived dataset in step with the commits. Each commit of a copy asks for one, so a refresh can run while a copy loads, and it reads only what committed. A refresh makes again only what changed.
_Avoid_: Rebuild, recompute, sync, update

**Derived status**:
What the refreshes of one derived dataset left, which readers see in `derived_status`: `waiting`, `refreshing`, `current` or `failed`, with `as_of`, the time that the last refresh which ended began to read, and the counts of a computed dataset.
_Avoid_: Health, freshness (freshness is how current a stream is)

**Dataset failure**:
A failure of a derived dataset itself, for example SQL that its store refuses. It fails only its dataset: the derived status shows `failed`, the other datasets still refresh, and the refresh after the next pass tries it again. A watch gives it as a `DatasetFailure` when the dataset starts to fail. A run rejects with it at its end, as itself: a `DerivedDatasetError`, or a `DerivedDatasetsError` when more than one dataset failed.
_Avoid_: Crash, error (a rule failure is also an error)

**Rule**:
The class that turns each input of a computed dataset into its output, for example the text of a file or the vector of a listing. The caller gives the rule.
_Avoid_: Transform, mapper (a mapper changes records while they load), function. eca's rule is a different word, in a different context

**Rule column**:
A column that a rule adds to each output, with its kind: `text`, `blob`, `integer` (a safe integer) or `vector` (a `Vector` of `@zukhruf/vectors` with a fixed number of dimensions). The kind sets the type of the value, and each destination keeps each kind in its own form.
_Avoid_: Field (a stream has fields), output column (the dataset adds its own columns too)

**Declared index**:
An index that a computed dataset declares on one of its tables, of the type `DatasetIndex`: an ordinary index over key columns, or a vector index over one vector column with its metric (`cosine`, `euclidean` or `dot`). The destination makes it at each refresh and drops it when the declaration no longer has it, so an index of another name, such as a person's own, stays.
_Avoid_: Hook, post-hook (dbt's word), physical property (SQLMesh's word for more than indexes)

**Input**:
What a rule reads from one row that a copy loaded.
_Avoid_: Source (a source reads an upstream), record

**Key**:
The name of an input and of its output, for example the ref of a stored file.
_Avoid_: Id, primary key (the loaded row has its own primary key)

**Output**:
What a rule made of one input: a value, nothing to keep (empty), a rule failure, or nothing because the input was gone.
_Avoid_: Result, row (the dataset keeps the output in a row)

**Rule identity**:
What made an output, for example the parser of a format or the model. The dataset makes an output again when its rule identity changes.
_Avoid_: Version

**Rule failure**:
A rule that failed on one input. The output records why, and the load continues.
_Avoid_: Dataset failure, dead letter, error row

**Table rule**:
A rule that gives one or more parts for one input, for example the chunks of a text, as a table function of SQL gives rows. The dataset keeps one output for each key, and the parts of the output beside it.
_Avoid_: Splitter, set-returning function (a function of Postgres), multi-output rule

**Part**:
One of the rows that a table rule gives for one input, in order. It has the values of its content columns and of its place columns. Its `seq` is its order in the input, from 0.
_Avoid_: Chunk (a chunk of `@eltjs/chunking` is one kind of part), child row, item

**Content column**:
A column of a part that tells what the part is, for example the text of a chunk and its count of tokens. The part hash covers it.
_Avoid_: Value column, data column

**Place column**:
A column of a part that tells where the part is in its input, for example the offsets of a chunk. The part hash does not cover it, so a part that only moved keeps its part hash.
_Avoid_: Metadata, position (a position is a commit of a destination), offset

**Part hash**:
The SHA-256 of the content columns of a part. It does not cover the `seq` or the place columns. Two parts with the same content have the same part hash, so a dataset that reads the parts can key them by content.
_Avoid_: Part id, row hash (a row hash covers each column of a row)
