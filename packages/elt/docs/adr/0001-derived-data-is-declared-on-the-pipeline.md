# Derived data is declared on the pipeline

Context Compiler keeps the text of each stored file, so that SQL can search attachments. That text is not in an upstream. Its input is what the pipeline wrote: the stored files of the copies. Thus it is derived data, as Kleppmann describes in _Designing Data-Intensive Applications_, part III.

The first form was a source over the stored files. Then the pipeline was its own upstream, and a source must read an upstream. The second form was a class in the host. The host started it after each pass of a run, and it wrote its own loop for a watch. Only the code of the host kept that order. This is temporal coupling: a second host must copy the order, or it loses the text.

Airbyte has no step after a load. It removed its custom dbt operations in 2024, and after a sync it only sends signals. elt is different: its hosts are desktop programs with no orchestrator, and the pipeline is the orchestrator.

Thus a derived dataset is an elt concept. A host declares each derived dataset in `new Pipeline({ history, connections, derived: [...] })`. The pipeline decides when a refresh starts. Each kind decides how it makes its data: a view computes on read, and a computed dataset computes on write. A derived dataset is declared on the pipeline, not on a connection, because its output can be in a different destination than its input. For example, a vector store can keep the vectors of listings that a SQLite file keeps. Airbyte also makes each vector store a destination.

## Considered Options

- **A source over the stored files.** The pipeline then reads what it wrote, as if it were an upstream.
- **A hook after each pass, and the host keeps the work.** The host still writes the loop of each derived dataset, and a required step that is optional can be left out.
- **A derived dataset on each connection.** An output in a different destination than its input then has no place.
- **Derived datasets on the pipeline.** This option was selected.

## Consequences

- A host declares a derived dataset and writes no loop for it. Context Compiler declares its `attachment_text` in this way.
- Each kind is a class of a destination package: `View` and `ComputedDataset` of `elt-sqlite`. The Postgres destination has no kinds yet (#3186).
- A copy can still parse a file while it loads, with `.parse()`. That copy then waits for each parse.
