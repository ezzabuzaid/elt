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
  - a resource id that the vendor documents for a web API, or the id that an app writes as its own identity, such as Dia's archived-tab UUID, or the position of an entry in a list that Google Health or Search Console returns;
  - SQLite's `rowid` for a table that declares no key and no unique index, such as Activity's `DevicePeer` and Chromium's `keyword_search_terms`;
  - the `rowid` with a stable column, when a stream keeps rows that its store has forgotten. SQLite gives a freed `rowid` to a new row in a table without `AUTOINCREMENT`, so the `rowid` alone can name two rows. Notification Center keys a notification by `[rec_id, uuid]`.
- Business identifiers, such as WhatsApp's JIDs and stanza ids, are columns. Readers join on them where they need to.
- No source and no SDK deduplicates rows. A repeated key fails the read with `twice in one scan`. That failure is the check that the key is wrong, and the fix is a key that the upstream enforces.
- `e6d595cb` keys every WhatsApp CoreData stream by `id` (`Z_PK`) and each decoded record by its owner's id and position. It removes `messageCopies`, the copy count, the content and copy key parts, and `unique()`. `3804bf4d` keys Call History's `callParticipants` by `[callId, handleId]`, the declared key of `Z_2REMOTEPARTICIPANTHANDLES`, and Contacts' `unknownProperties` by `[recordId, id]`, and removes the seen-set and `SELECT DISTINCT`.
- `211740a7` keys Activity's devices by the `rowid` of `DevicePeer`.
- `c75688a2` keys Chromium's `searchTerms` by the `rowid` of `keyword_search_terms`.
- `234819c0` keys Notification Center's notifications by `[rec_id, uuid]`, and apps by `app_id`.
- `63f9546b` keeps the tab UUID that Dia writes as the key of `archivedTabs`.
- `3ebf323e` keys Google Health's `caloriesInHeartRateZone` by date and position in the day's list.
- `642e69cb` keys Search Console's `sitemapContents` by position in the sitemap's contents list.

## Precedents

- **Airbyte** takes `source_defined_primary_key` from the upstream's constraint, as its database sources read the table's declared key. Deduplication is the job of the destination (`append_dedup`), not of the source.
- **CoreData** identifies a managed object by its `NSManagedObjectID`, which is the entity and `Z_PK` of its row. No attribute of the object is its identity.
- elt's **SQL Server source** takes the key of a stream from the table's declared primary key, and reads a table with no key in full (`sql-server-source.ts`).

## Considered Options

- **Keep the business key, and drop repeats.** The read succeeds, and rows are lost with no message.
- **Keep the business key, and add key parts or a copies stream for each repeat that is found.** Each new kind of repeat fails a stream again, and each fix adds a part that has no meaning for the reader.
- **Key each stream by an identity that the upstream enforces.** This option was selected.

## Consequences

- A scan in parts (`continues`) catches a repeated key only inside one part. Two parts can list one key, because a page of the upstream can move while the scan goes on (snapshot-differential ADR 0002), so a key that two pages of one scan repeat loads one row with no error. For a source that lists one part for each page, such as the web pages source, the key that the upstream enforces is the only guard.
- A store that repeats a business identity loads each of its rows. A reader that wants one row for each business identity deduplicates by the business columns.
- The key of a CoreData row does not survive a restore or a rebuild of the store, because the store gives new `Z_PK` values. After such a restore, a fresh run loads the store again.
- The `rowid` of a table that declares no key changes when `VACUUM` gives new numbers to its rows. The next read then shows the old rows as deleted and the same rows as inserted.
- `eslint.config.mjs` blocks the dedupes that a machine can see in the shipped code of `packages/sdks/**` and `packages/sources/**`: `SELECT DISTINCT`, `UNION`, `INTERSECT` and `EXCEPT` without `ALL` in a string or template, a function named `unique`, `uniq`, `dedupe` or `distinct` (also with `By` or `With`), and an import of such a helper. A seen-set (`new Set` with `has`) and `[...new Set(...)]` stay unchecked, because the code that filters input values or lists the ids for a query uses the same syntax. Review catches them.
