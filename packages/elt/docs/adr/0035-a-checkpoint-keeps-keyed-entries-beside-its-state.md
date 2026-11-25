# A checkpoint keeps keyed entries beside its state

Status: proposed (elt #4468, #2920), the API on paper before any code.

A checkpoint is one JSON value per replication, and each save writes it whole. A web stream saves after each page, and its state holds a record for every URL that its crawl knows and the diff's records of every page. At about 583 bytes for each known URL, a crawl of City Center's 10,913 sitemap URLs saves about 6.4 MB after each page, so one crawl of that one shop writes about 70 GB. A crawl of OpenSooq's ~160k listings saves about 93 MB after each page. This is write amplification: each save writes far more than what changed, as a program that rewrites a whole file to change one line.

On 2026-10-24 Ezz removed an earlier answer to #2920, RFC 6902 patches of the state with append journals and compaction, because it was an optimization only ("less code is better than faster software"), and on 2026-10-26 he deferred it again until a large listing needs it, with no source-specific store, custom hashing, custom patch interpreter or migration. The Jordan product search (context-compiler #5634) is that listing: its crawls cannot run on its server as they are.

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

2. **A resumed source reads the entries of a space.** `states.get(stream)` gives the state as before. `states.entries(stream, space)` gives that space's saved entries as a `ReadonlyMap<string, unknown>`, read once when the stream starts, and empty for a replication never saved. The entries stay in memory for the read, as Scrapy and Crawlee's file storage keep theirs.

3. **The checkpoint store owns the entries.** `CheckpointSession.save` writes the checkpoint's row and the puts and removes of its entries in one transaction, so the state and its entries are durable together, after the destination committed the records (commit before checkpoint, as before). `remove` and the reset of a reload delete the entries with the row. Each store keeps them in a table of its own: `checkpoint_entries(id, space, key, value)` with the key `(id, space, key)`; SQLite `STRICT, WITHOUT ROWID`, Postgres `value JSON`, SQL Server with a persisted `HASHBYTES` key, as its checkpoints already have.

4. **Each SDK gives its changes as plain data.** The web crawler's snapshot gives the known URLs that changed or left since its last snapshot, and a crawl resumes from its memento and its known URLs; `@zukhruf/snapshot-differential` gives the groups that changed. Neither imports elt. The web source puts the crawler's changes in the `crawl` space and the diff's in the `diff` space.

## Considered Options

- **Patches of the whole state (RFC 6902), with a journal and compaction.** Removed on 2026-10-24: a patch interpreter and a journal are custom machinery, and a source still builds the whole state to patch it.
- **Save the state less often.** Rejected on 2026-10-26: head-of-line blocking, and a stop loses the progress since the last save.
- **Cap or drop old keys, as Airbyte does past 10,000 partitions.** It loses data.
- **A store owned by the crawler.** A second transaction could make a URL's progress durable before its page's records, and the crawler would depend on a store.
- **Keyed entries in the checkpoint store.** This option was selected.

## Consequences

- A save writes what changed since the last save: one page's known URL and its diff group, not every page before it.
- A source that keeps all its state in `state` changes nothing.
- Each checkpoint store gains a table and a transaction around each save. The stores treat old checkpoints as disposable, so no migration exists.
