# A reading history that cannot be read fails and keeps its rows

The reading history is one CRDT document in the table `ZCRDTMODELSYNCENTITY`. The first reader gave an empty history when the table held more or less than one live document, or when the document was not bytes. The snapshot diff then deleted every row of `readingMonths`, `readingDays` and `streakRecords` (backlog item 2301).

The Core Data model of Books (`CRDTModelSync2.mom` in `BookDataStore.framework`) puts no uniqueness constraint on the entity. Each row has a salted, hashed ID. Thus two live documents can exist, and nothing tells which one Books reads.

Now the reader fails with `BooksSchemaError` when it finds two or more live documents, or a document that is not bytes. It also fails on a format version that is not 4. The three reading streams fail. The other streams of Books load, and the rows that the copies loaded before stay.

## Considered Options

- **Read an empty history.** The diff then deletes every row of the reading history.
- **Pick one of the live documents.** Nothing tells which document Books reads.
- **Fail the three reading streams.** This option was selected.

## Consequences

- A store with no live document, or with a document that has no data yet, still reads as empty.
- A reading history in a format that the reader does not know never deletes rows.

Sources: commit 4c70060e, backlog item 2301; commit 5dcd0609 (format version 4).
