# A stream whose fields change keeps its rows and its checkpoint

Before, a change to the fields of a stream started its copy again. elt discarded the checkpoint and reloaded the copy into a hidden table. Thus rows that the upstream did not hold now were lost. Examples are a notification that usernoted dropped, and Activity and Safari records past their retention (#2437). Airbyte never reads a source again on a schema change.

Thus a changed field (added, removed, a new type, nullable or required) keeps the checkpoint and the rows. Before the copy reads, the destination evolves the stored table in place. SQLite copies the rows into a table of the new definition in one transaction. Postgres runs `ALTER TABLE`: add a nullable column, drop a column, `TYPE ... USING` a cast, `DROP NOT NULL`. A stored value that the new shape refuses fails the copy. The error names the column, and the table and the checkpoint stay as they were.

An overwrite replaces each row in all cases, so its target that does not fit reloads into a hidden table, as the truncate syncs of Airbyte do.

A changed declaration (name, `primaryKey`, `partitionKey`, `supportedSyncModes`, `supportsFileTransfer`, `sourceDefinedCursor`, `emitsDeletes`, `expiresBy`) stops the copy with `StreamChangeError`. The host then resets the checkpoint, which keeps the rows, or clears the copy.

## Considered Options

- **Start the copy again on each change of the shape.** Rows that the upstream does not hold now are lost.
- **Evolve the stored table in place and keep the checkpoint; stop the copy on a changed declaration.** This option was selected.

## Consequences

- A stored table is `NOT NULL` only on `loaded_at` and on the explicit primary key columns. The destination still checks the required fields of each record that it writes.
- A new field gets values only from the source. A snapshot diff emits again each changed record. The rowversion and Change Tracking states of SQL Server record the fields that they read, and a new field makes them read again.
- Live, a Notification Center import kept a Calendar alert that usernoted had expired, through a field that was added to notifications.

Sources: elt c77d75db; backlog #2437, #2464, #2465, #2469.
