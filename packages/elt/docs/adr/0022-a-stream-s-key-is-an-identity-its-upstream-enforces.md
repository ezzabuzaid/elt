# A stream's key is an identity its upstream enforces

`Stream.primaryKey` is the identity of the source (Airbyte's `source_defined_primary_key`). A destination deduplicates on it, and the snapshot differential (`diffSnapshot`) fails a read whose scan gives one key two times: `returned <key> twice in one scan`. These checks are correct only when the key is an identity that the upstream itself keeps unique.

The WhatsApp source did not obey this. Since `b1543924` it keyed its streams by WhatsApp's business identity, for example a message by `chatJid`, `isFromMe` and `stanzaId`. ChatStorage does not enforce that identity: its `stanzaId` index is not unique, and a history sync adds rows. On one Mac, 82,077 message rows held 82,076 such keys, 778 chat sessions held 776 JIDs, and 329 group changes held 328 keys. The repeats were hidden or patched:

- `unique()` dropped a repeated chat session, group change and business hours row with no message.
- `c8906864` (#4367) added the link's content to the key of `messageDataItems`, after a message with four links at index 0 failed with `twice in one scan`.
- `ed7ef317` (#4379) added a `messageCopies` stream for a message that WhatsApp keeps on a second row.

Two more sources had the same problem. The Call History source dropped repeated participants with a seen-set, and the Contacts SDK read `ZABCDUNKNOWNPROPERTY` with `SELECT DISTINCT`. Each hid 0 rows on the Mac of the probe, but each could hide a row of another store.

This is the problem of a natural key against a surrogate key. A natural key is a business attribute, such as a message's `stanzaId`. A surrogate key is an identity that the store makes, such as CoreData's `Z_PK`. A candidate key is valid only when the store enforces it.

## Decision

- The primary key of a stream is an identity that its upstream enforces:
  - a `PRIMARY KEY` or `UNIQUE` constraint that the store declares;
  - CoreData's `Z_PK` within its entity, with what picks the store when a source reads several stores;
  - for a record decoded from a blob, the key of its owner row and its position in the blob.
- Business identifiers, such as WhatsApp's JIDs and stanza ids, are columns. Readers join on them where they need to.
- No source and no SDK deduplicates rows. A repeated key fails the read with `twice in one scan`. That failure is the check that the key is wrong, and the fix is a key that the upstream enforces.
- `e6d595cb` keys every WhatsApp CoreData stream by `id` (`Z_PK`) and each decoded record by its owner's id and position. It removes `messageCopies`, the copy count, the content and copy key parts, and `unique()`. `3804bf4d` keys Call History's `callParticipants` by `[callId, handleId]`, the declared key of `Z_2REMOTEPARTICIPANTHANDLES`, and Contacts' `unknownProperties` by `[recordId, id]`, and removes the seen-set and `SELECT DISTINCT`.

## Precedents

- **Airbyte** takes `source_defined_primary_key` from the upstream's constraint, as its database sources read the table's declared key. Deduplication is the job of the destination (`append_dedup`), not of the source.
- **CoreData** identifies a managed object by its `NSManagedObjectID`, which is the entity and `Z_PK` of its row. No attribute of the object is its identity.
- elt's **SQL Server source** takes the key of a stream from the table's declared primary key, and reads a table with no key in full (`sql-server-source.ts`).

## Considered Options

- **Keep the business key, and drop repeats.** The read succeeds, and rows are lost with no message.
- **Keep the business key, and add key parts or a copies stream for each repeat that is found.** Each new kind of repeat fails a stream again, and each fix adds a part that has no meaning for the reader.
- **Key each stream by an identity that the upstream enforces.** This option was selected.

## Consequences

- A store that repeats a business identity loads each of its rows. A reader that wants one row for each business identity deduplicates by the business columns.
- The key of a CoreData row does not survive a restore or a rebuild of the store, because the store gives new `Z_PK` values. After such a restore, a fresh run loads the store again.
- `eslint.config.mjs` blocks the dedupes that a machine can see in the shipped code of `packages/sdks/**` and `packages/sources/**`: `SELECT DISTINCT`, `UNION`, `INTERSECT` and `EXCEPT` without `ALL` in a string or template, a function named `unique`, `uniq`, `dedupe` or `distinct` (also with `By` or `With`), and an import of such a helper. A seen-set (`new Set` with `has`) and `[...new Set(...)]` stay unchecked, because the code that filters input values or lists the ids for a query uses the same syntax. Review catches them.
