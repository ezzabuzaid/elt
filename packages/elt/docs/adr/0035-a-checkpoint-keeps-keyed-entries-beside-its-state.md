# A checkpoint keeps keyed entries beside its state

Status: accepted (elt #4468, #2920).

A checkpoint is one JSON value per replication, and each save writes it whole. A web stream saves after each page, and its state holds a record for every URL that its crawl knows and the diff's records of every page. One real checkpoint was measured at about 583 bytes for each known URL. From that value, the checkpoint of a crawl of City Center's 10,913 sitemap URLs grows to about 6.4 MB, so one full first crawl of that shop writes about 35 GB; a later crawl saves only for the pages that are due. A crawl of OpenSooq's ~160k listings would save about 93 MB after each page. These are calculations, not measurements of a shop crawl. This is write amplification: each save writes far more than what changed, as a program that rewrites a whole file to change one line.

On 2026-10-24 Ezz removed an earlier answer to #2920, RFC 6902 patches of the state with append journals and compaction, because it was an optimization only ("less code is better than faster software"), and on 2026-10-26 he deferred it again until a large listing needs it, with no source-specific store, custom hashing, custom patch interpreter or migration. For the Jordan product search (context-compiler #5634), whose first scope is retail shops, this is a cost of disk writes and CPU, not a limit: its crawls run. It is a limit at OpenSooq's size. Decisions 1 to 3 are built. The grouped snapshot of `diffGroupedSnapshot` keeps its collections in the spaces `diff`, `diff:unknown` and `diff:listed` ([ADR 0036](./0036-a-grouped-snapshot-is-kept-in-three-spaces-of-keyed-entries.md)), so the web stream's diff writes entries; the crawler's URL records are kept in the `crawl` space too (decision 4, step 3 of #4468, sdk-web-crawler ADR 0011).

The established tools keep keyed state as one record for each key. Flink keeps an operator's keyed state in RocksDB, and an incremental checkpoint uploads only the files that changed (apache/flink 9b82e9ca, `RocksIncrementalSnapshotStrategy`). Nutch's CrawlDb, StormCrawler's status index, Heritrix's frontier in Berkeley DB and Crawlee's request queue keep one record for each URL. Airbyte re-emits a stream's whole state, throttles its STATE messages to one each 600 seconds, and caps partitions at 10,000 (airbyte-python-cdk 9b547097, `concurrent_partition_cursor.py`); elt rejected a save timer (head-of-line blocking: one slow page holds back the commit of the pages read before it) and caps (they lose data).

## Decision

1. **A STATE message can carry the changes of its keyed entries.** Beside `state`, a source yields `entries`, the changes since its last STATE: for each space, the keys to put with their values, and the keys to remove. A space names one consumer of the replication's state, such as `crawl` or `diff`, so their keys do not meet. A STATE with no `entries` changes no entry.

   ```ts
   export type StateMessage = {
     readonly type: 'STATE';
     readonly stream: string;
     readonly state: unknown;
     readonly entries?: Readonly<
       Record<
         string,
         {
           readonly put?: Iterable<readonly [key: string, value: unknown]>;
           readonly remove?: Iterable<string>;
         }
       >
     >;
   };
   ```

2. **An extract reads the entries of its own stream or partition.** `extract` gets a last argument, `entries: SavedEntries`, and `entries.space(name)` gives that space's saved entries as a `ReadonlyMap<string, unknown>`. elt reads them from the store when the extract asks, so no call order is required, and a space never saved, or a read that resumes from no checkpoint, gives an empty map. The extract keeps the entries in memory for the read, as Scrapy and Crawlee's file storage keep theirs. `states.get(stream)` gives the state as before.

   elt scopes the entries to the stream, and for a partitioned stream to the partition, before it calls `extract`, as Flink scopes keyed state to the current key before it calls the operator: the record processor calls `setKeyContextElement(record)` and then `processElement(record)` (apache/flink 60fa0b4b, `flink-runtime/src/main/java/org/apache/flink/streaming/runtime/io/RecordProcessorUtils.java`, lines 61-65), and `setKeyContextElement` takes the key from the record with the operator's key selector and gives it to `setCurrentKey`, which sets it on the keyed state backend (apache/flink 8d7da028, `flink-runtime/src/main/java/org/apache/flink/streaming/api/operators/AbstractStreamOperator.java`, lines 612-626). Two inputs of a web stream that name one URL therefore keep two entries. The core maps a partition and a space to one stored space: the partition's key as a JSON string, followed by the space's name. A JSON string ends where the key ends, so no partition's scope begins another's. A stream that is not partitioned stores its spaces under their own names. The stores know no partition.

   The entries follow the state:

   - A partition that the stream no longer lists leaves the next STATE's state, and the same save clears its entries.
   - A RESET of a partition clears that partition's entries at that partition's own next STATE, before the STATE's own changes, and only once: a second STATE keeps the puts of the first. Another partition's STATE does not carry the clear. A partition that resets and then fails before its STATE clears nothing, as its state in the checkpoint did not move either. A RESET of a stream that is not partitioned clears all the stream's entries in the same way, so its next save keeps only its own puts, as a save whose read started from no checkpoint does. Until that STATE, the extract still reads the saved entries, as its `state` stays the saved one.
   - A reload that resumes keeps the entries, as it keeps the state.
   - A space or a key must not hold U+0000. Postgres keeps them as `TEXT`, which refuses it, and the save would fail after the destination committed, so each replay of the run would fail in the same way. elt refuses such a STATE before the commit, with the other checks of its shape.
   - A space, a key or a value must not hold a lone surrogate, as state must not: no store keeps it as the same text (`wellFormed`). elt refuses such a STATE before the commit too.
   - Only `Source.read` names the scopes that a save clears. A STATE from an extract that names its own `clear` fails the copy before the commit, as an extract could otherwise clear another partition's entries.

3. **The checkpoint store owns the entries.** `CheckpointSession.save` writes the checkpoint's row and the changes of its entries in one transaction: first it clears each scope that the save names (every entry whose space begins with it), then the removes, then the puts, so the state and its entries are durable together, after the destination committed the records (commit before checkpoint, as before). `remove` and the reset of a reload delete the entries with the row. `CheckpointSession.entries(id, space)` reads one space. Each store keeps them in a table of its own: `checkpoint_entries(id, space, key, value)`, unique by `(id, space, key)`. SQLite keys the texts themselves, `STRICT, WITHOUT ROWID`. Postgres and SQL Server key the SHA-256 digests of id, space and key (of their UTF-8 in Postgres, their UTF-16 in SQL Server), with the full texts beside them for reads and for the clear of a scope: a Postgres btree row holds at most about 2.7 KB and a clustered SQL Server key 900 bytes, so a long URL as a key would fail. Postgres computes the digests in the statements that write and read (`sha256(convert_to(..., 'UTF8'))`), since `convert_to` is not immutable and so cannot fill a generated column; SQL Server keeps them as persisted `HASHBYTES` columns, as its checkpoints already have. Postgres keeps `value` as `JSON`, which keeps the exact text, `\u0000` included.

   The entries are written after the row, in the same transaction, so a failure of the entries write would leave the save undone after the destination committed, and each replay would fail in the same way. No public input reaches such a failure: elt refuses a STATE whose names hold U+0000 or a lone surrogate, or whose values are not lossless JSON, before the commit; every key of an entries table is a fixed-size digest or, in SQLite, a text of any length; and Postgres reads the puts as JSON text in strings, since `json_array_elements` refuses a `\u0000` escape anywhere in the array it reads. Only the store's own failures remain, such as a lost connection, which a replay outlives.

4. **Each SDK gives its changes as plain data.** The web crawler's snapshot gives the known URLs that changed or left since its last snapshot, and a crawl resumes from its memento and its known URLs; `@zukhruf/snapshot-differential` gives the groups that changed. Neither imports elt. The web source puts the crawler's changes in the `crawl` space and the diff's in the `diff` space.

## Considered Options

- **Patches of the whole state (RFC 6902), with a journal and compaction.** Removed on 2026-10-24: a patch interpreter and a journal are custom machinery, and a source still builds the whole state to patch it.
- **Save the state less often.** Rejected on 2026-10-26: head-of-line blocking, and a stop loses the progress since the last save.
- **Cap or drop old keys, as Airbyte does past 10,000 partitions.** It loses data.
- **A store owned by the crawler.** A second transaction could make a URL's progress durable before its page's records, and the crawler would depend on a store.
- **Keyed entries in the checkpoint store.** This option was selected.

## Consequences

- A save writes what changed since the last save: one page's known URL and its diff group, not every page before it. No black-box test shows this, since a save that wrote every entry again gives the same reads; step 5 of #4468 shows it by measuring the checkpoint bytes of a real crawl.
- A source that keeps all its state in `state` changes nothing.
- Each checkpoint store gains a table and a transaction around each save. The stores treat old checkpoints as disposable, so no migration exists.

## Confirmation

Measured on 2026-11-26 by the session mutex-7e (step 5 of #4468) on a live crawl of City Center's sitemap (`https://citycenter.jo/sitemap.xml`, 10,913 URLs), at elt 0dbe6078, with `ListingReader`, `ProductExtractor` and `SQLiteCheckpointStore`, stopped after the first 150 page saves (152 seconds). A subclass of the store recorded each save's state and entry changes, in UTF-8 bytes of space, key and value. The bytes that one save wrote before this decision are the checkpoint's whole content at that save: the state and every entry, which the old save wrote as one value.

| Save                                                         | Written now                          | Written before (one value)                                      |
| ------------------------------------------------------------ | ------------------------------------ | --------------------------------------------------------------- |
| The first save: the sitemap's 10,913 URLs enter the frontier | 6,852,679 bytes                      | 6,852,679 bytes                                                 |
| Each later save                                              | 1,507 bytes (median; 1,335 to 1,991) | 6,853,721 bytes at the second save, 745 bytes more at each page |
| All 150 saves                                                | 7,084,272 bytes                      | 1,036,179,781 bytes (146 times more)                            |

A later save writes the three changes of one page: its group in `diff` (about 420 bytes), its key in `diff:listed` (about 150 bytes) and its URL record in `crawl` (about 710 bytes). The calculation in the context above assumed that the checkpoint grows from nothing. The measurement shows that the sitemap puts all its URLs in the frontier at the first save, so before this decision each save of that crawl wrote at least 6.85 MB. From the measured rates, one full crawl of the 10,913 pages writes about 23 MB now and wrote about 119 GB before; this total is a projection, not a measurement.
