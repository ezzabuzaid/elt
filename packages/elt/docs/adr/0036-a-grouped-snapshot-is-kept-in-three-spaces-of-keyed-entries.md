# A grouped snapshot is kept in three spaces of keyed entries

Status: accepted (elt #4468, step 4).

Decision-makers: the elt session that designed step 4 of #4468 ("2026-11-25 STEP 4 DESIGN"), from the evidence and the precedents below. Ezz chose keyed entries over one value on 2026-11-26 ("Keyed entries"), after a Five Whys and a study of the leaders.

`diffGroupedSnapshot` kept the grouped snapshot of a stream in its `state`, and each `STATE` saved the whole snapshot as one JSON text. The checkpoint of Mail's `messageHeaders` on this Mac held 257,129,299 characters (2026-11-26), and a pass of Mail wrote about 292 MB. A V8 string holds at most 536,870,888 code units, so a mailbox twice as large makes `JSON.stringify` throw before the commit, and the stream never commits again. A web stream saves after each page, so each page rewrote every page before it: write amplification, O(N) for each page and O(N²) for each crawl.

`@zukhruf/snapshot-differential` 0.8.119 gives a grouped snapshot as three keyed collections, `groups`, `unknown` and `listed`, and its state change gives the new snapshot and what changed in each collection (its ADR 0011). [ADR 0035](./0035-a-checkpoint-keeps-keyed-entries-beside-its-state.md) gives a checkpoint keyed entries, saved in the transaction of the state after the records commit.

## Decision

1. **Three spaces.** elt keeps each collection in a space of the extract's keyed entries: `diff` for the groups, `diff:unknown` for the unknown keys with their holders, `diff:listed` for the listed groups. Source.read scopes the spaces to the stream, and to the partition of a partitioned stream (ADR 0035), so the same page key in two partitions or two streams keeps two snapshots.
2. **The STATE carries the changes, not the snapshot.** At each state change, `diffGroupedSnapshot` yields a `STATE` whose `state` is `null` and whose `entries` are the package's changes of the three collections: the puts and the removes. Thus a part that reads one page writes the page's group and its listed entry, and the part that ends the scan removes the listed groups.
3. **A resume reads the spaces.** `resumeGroupedSnapshot(configuration, entries)` reads the three spaces and gives them to `savedGroups`, which checks each entry. An extract with no saved entries gets an empty snapshot. `diffGroupedSnapshot(configuration, groups, snapshot, options)` takes the snapshot.
4. **The STATE also gives the new snapshot.** A source that diffs one scan in several calls of one extract, such as the web source for each page and Instagram's comments for each part of a grid, gives the `snapshot` of the last `STATE` to the next call. It does not read the entries again: the store would give the same snapshot, since the yield of a `STATE` returns after its save (`interleave` asks a stream for its next message only after the consumer took the last one), but each page would read every entry, O(N) for each page again. Such a source yields `{ type, stream, state, entries }` with a state of its own, which no longer holds the diff. A source that diffs once yields the messages of the diff as they are.
5. **Old checkpoints are not read.** A checkpoint whose `state` holds a grouped snapshot is old output (elt's AGENTS.md, "Stored data is disposable"). Its entries are empty, so the next run diffs from an empty snapshot: it loads every record again, and it deletes nothing that the old snapshot held. A fresh run rebuilds the checkpoint. No code reads the old shape.

## Considered Options

- **Keep the snapshot in `state`, as three objects.** Each save still writes the whole snapshot as one text, and the V8 limit stays.
- **Read the entries again at each call of an extract.** Each page reads the whole snapshot from the store and parses it, O(N) for each page.
- **A class that holds the snapshot between calls.** It hides the snapshot from the source, but it is a second API beside the functions, and a source that diffs once would still have to build it.
- **Three spaces, a `null` state and the snapshot on the STATE.** This option was selected.

## Consequences

- A save writes the entries that changed: one page's group and its listed entry in a crawl, nothing of the diff for a pass whose groups did not change.
- The `STATE` of a grouped diff carries `snapshot`, an object that no store saves. A source that yields the messages of the diff as they are passes it to `Source.read`, which ignores it.
- WhatsApp chose to read every message in one join when its state was `null`; it now chooses so when the resumed snapshot has no group.
- The differential still builds the index of every saved key at each call (CPU, ADR 0011 of the package).

## Confirmation

- `packages/destinations/sqlite/src/grouped-snapshot-entries.test.ts`, through a real `Pipeline`, `SQLiteDestination` and `SQLiteCheckpointStore`, with a source that diffs a scan page by page as the web source does: a scan that a failed run leaves open goes on with the pages its saved parts listed, and its last part deletes only what no part listed; a resumed scan, in parts and in one diff, deletes the records of a page it no longer finds and that page's entry, and loads nothing for the unchanged pages; each page save writes that page's `diff` entry and its `diff:listed` entry and nothing else, the save that ends the scan removes the listed entries, and a later scan writes the entry of a changed page only (SQLite triggers on `checkpoint_entries` record each write with the state of its save, so this consequence of ADR 0035 is now shown by a test); a stream that yields the messages of the diff as they are saves `null` as its state; two partitions that give one page key keep their own snapshots; a record that left a page in a part that a failed run saved waits in `diff:unknown` for the part that ends the scan, which deletes it, or loads nothing for it when another page gives it unchanged.
- Each claim was proven with `mutate.mjs` of the write-test skill, each mutant in memory: resuming no `diff:listed`, no entries, no `diff:unknown`; putting every group at each save; a snapshot in `state`; dropping the partition's scope in `Source.read`. Each was CAUGHT. In each of the five sources, a resume from no entries was CAUGHT by its own tests (Mail 'Mail message streams re-read only messages whose files or index attachment rows changed', WhatsApp 'compact message scans keep unchanged groups across reopened pipelines…', Activity '…rereads only changed segments', web `unchanged-pages.test.ts` and `web-source.test.ts`, Instagram 'comments load with their replies…'), and a web source or Instagram comments stream that keeps the first snapshot in place of each `STATE`'s was CAUGHT by `gone-pages.test.ts` and the Instagram comments test.
