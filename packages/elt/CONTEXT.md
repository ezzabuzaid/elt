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
One call of `pipeline.run()`: one pass of each connection, then one refresh of each derived dataset.
_Avoid_: Sync, execution

**Watch**:
One call of `pipeline.watch()`: a pass each time that a source tells of a change, until the signal aborts.
_Avoid_: Subscription, daemon, poll

**Commit**:
Rows that a destination made durable. A pass can make many commits.
_Avoid_: Save, write, flush

**Host**:
The program that makes a pipeline and starts its runs or its watch, for example the CLI of Context Compiler.
_Avoid_: App (in Context Compiler, an app is a macOS application), runner

**Stored file**:
A copy of a source's file that a copy kept in a file storage, for example `LocalFiles`. A row names it by its ref.
_Avoid_: Attachment (an app's word; a stored file can be any file), blob

**Ref**:
The path of a stored file, relative to the folder of its file storage. The SHA-256 of the bytes names the file.
_Avoid_: Path (a path can be absolute), id

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
The pipeline brings one derived dataset in step with the commits. A refresh makes again only what changed.
_Avoid_: Rebuild, recompute, sync, update

**Dataset failure**:
A failure of a derived dataset itself, for example SQL that its store refuses. It rejects the run, or it stops the watch.
_Avoid_: Crash, error (a rule failure is also an error)

**Rule**:
The class that turns each input of a computed dataset into its output, for example the text of a file or the vector of a listing. The caller gives the rule.
_Avoid_: Transform, mapper (a mapper changes records while they load), function. eca's rule is a different word, in a different context

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
