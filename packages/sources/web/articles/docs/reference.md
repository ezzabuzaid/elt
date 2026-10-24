# Web source behavior and verification

## Ownership and package decisions

The upstream is the website or feed selected by the caller. The source reads it directly, not a dataset that the pipeline previously wrote. Package exports, options/types, and shipped runtime were read before implementation.

| Owner                               | Public API used                                                                | Responsibility                                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Web discovery SDK                   | `WebDiscovery.discover`                                                        | HTML/HTTP feed discovery, robots sitemap locations, sitemap/feed decoding and candidate deduplication                            |
| Web article SDK                     | `WebArticle.fetch`                                                             | HTTP, decoding, Readability selection, sanitization, text conversion, cancellation and attributed errors                         |
| ELT engine                          | `Source`, `Stream`, `Catalog`, `validateRecords`                               | Stream contract, schema validation and independent input partitions                                                              |
| ELT engine                          | `diffSnapshot` with `continues`                                                | New/changed record detection across partial scans; delegates fingerprinting to installed `@zukhruf/snapshot-differential` 0.3.28 |
| ELT engine/destination              | `Pipeline`, `Copy`, `Connection`, `SQLiteDestination`, `SQLiteCheckpointStore` | Commit ordering, deduplication, failure reporting, persistence, locking and full-refresh rollback                                |
| Installed Zod 4.6.5                 | `z.url`, `z.array`, `z.object`, `parse`                                        | HTTP input validation, polling interval validation and checkpoint-envelope parsing                                               |
| Node                                | `URLPattern`, `timers/promises.setInterval`, `AbortSignal`                     | Caller-defined URL selection, cancellable polling and request cancellation                                                       |
| Installed `@zukhruf/testing` 0.3.24 | `HttpServer.start`, `Sqlite.database`                                          | Real loopback HTTP and disposable SQLite fixtures                                                                                |

The executable package probe ran `diffSnapshot` across two continued parts and a final empty part, then changed one record. It retained earlier fingerprints and emitted the changed record. The source therefore needs only a traversal cursor around the engine's snapshot, with no custom hash, diff, queue, writer, lock or checkpoint store.

REJECTED: using sitemap `lastmod` or feed publication timestamps to skip articles. They are optional hints and do not establish that an old page is unchanged. Successful reruns refetch selected pages and compare their extracted records.

REJECTED: `diffGroupedSnapshot` as a download-skipping shortcut. Generic websites do not supply reliable content fingerprints before fetching. Its capability was inspected; the required upstream guarantee is absent.

REJECTED: a new crawling framework for persistence or resume. The engine already supplies those jobs. Request scheduling, retries, conditional fetching and crawl policy remain separate HTTP-layer work; this source does not implement substitute mechanisms.

RETAINED: both existing SDKs and the engine unchanged. The only new runtime dependency declaration is the already-installed Zod package. Schema descriptions and nullable metadata conversion belong to the source: Readability's public declarations allow undefined metadata, while stream cells require explicit null. A signal-less engine run gets an un-aborted signal because the existing SDK methods require one.

Removal audit: no existing production mechanism needed removal. This is an additive source integration: 1,002 added lines, zero removed, including 214 production lines, tests, documentation and workspace registration; unrelated checkout changes are excluded. The final source contains no compatibility path, publisher branch, fallback parser, forwarding module or unused export. Pattern strings remain available for declared coverage, and compiled patterns serve selection. `pollIntervalMs` is explicit configuration consumed by watching.

## State, identity and failure behavior

`articles` declares `sourceDefinedCursor`, supports full refresh and incremental extraction, and uses `(inputUrl, pageUrl)` as its primary key. Each configured input is an engine-managed partition. Adding or reordering inputs preserves other inputs' progress. URLs preserve query and trailing-slash distinctions. Redirect targets and canonical declarations remain separate metadata.

Discovery reads the current listings on every run. Candidates are sorted by URL. During an incomplete incremental scan, `after` identifies the last processed URL and `diff` holds the engine's opaque snapshot. Each processed page, including a null extraction, advances the cursor through a `STATE` message. The engine commits prior rows before saving that state. Finishing the scan clears `after`; the next complete pass checks all selected candidates again.

An HTTP failure stops that input and reports the failed URL through the SDK error. Other configured inputs can finish. Resume rediscovers listings and continues after the saved URL; changes or newly listed URLs at or before that cursor are revisited on the next complete scan. A permanently failing page remains a reported failure until upstream recovers or the caller changes its selection. Cancellation closes the active download, retains already committed records and propagates the caller's reason.

An absent listing entry is not proof of deletion: feeds routinely roll over. Incremental extraction declares no deletions and retains previously loaded rows, including when a later fetch returns no readable article. A full refresh has no incremental checkpoint and replaces the collection only on success. Removing an input or narrowing selection does not delete its already loaded rows in incremental mode; a full refresh rebuilds the chosen collection.

No load timestamp enters the source record, so an unchanged page does not create a false update. `publishedTime` and sitemap `lastModified` are raw upstream text, not inferred or normalized date fields. Missing extraction metadata is null. Article rows are processed one at a time, while discovery holds candidate URLs and snapshots hold fingerprints.

## Public regression ledger

Tests run through the exported `WebSource` module, a real `Pipeline`, the installed SDKs, real HTTP sockets and two independent package-owned SQLite databases. Controlled upstream pages are necessary to reproduce failures, cancellation and edits deterministically. No tests call publishers, seed checkpoint storage, replace internal modules, or use lifecycle hooks.

| Test claim                                                                                                      | First observed result                                                                | Final result |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------ |
| A failed page preserves committed articles; fresh-instance resume skips their HTTP downloads                    | Red: no committed article table                                                      | Pass         |
| Cancellation preserves the exact reason, closes the download and retains resumable progress                     | Passed directly using existing fetch/engine behavior                                 | Pass         |
| Website and feed input persist body/metadata; unchanged reruns emit nothing; changed/new articles update/insert | Red: missing persisted metadata column                                               | Pass         |
| Input failure isolation, added-input checkpoint continuity, null extraction and feed-rollover retention         | Passed using existing partition/diff behavior; strengthened after independent review | Pass         |
| Failed full refresh retains the complete prior collection; recovery replaces it                                 | Red: unsupported full-refresh mode                                                   | Pass         |
| Pipeline watching refreshes edited articles and stops on cancellation                                           | Red: watcher not implemented                                                         | Pass         |
| Explicit URL patterns prevent out-of-scope HTTP requests and preserve query variants                            | Red: excluded URL fetched and returned HTTP 503                                      | Pass         |

Independent `test-discoverer` and `test-claim-comparator` runs mapped the public seam and found the missing website/feed ingestion claim before implementation; that claim was added. The final comparator found no missing claims. The independent `test-gotcha-reviewer` found one evidence gap: rolling a completed feed to empty before adding inputs could hide discarded progress. The test now keeps that feed populated during extension, requires only two new writes, then rolls it over and requires zero writes with all three rows retained.

Mutation proof was not run: the write-test skill's supported procedure requires a repository copy, which this repository expressly prohibits; in-checkout mutation is also prohibited by that skill. Passing tests and observed red/green cycles are reported separately from mutation proof.

```sh
NX_DAEMON=false NX_ISOLATE_PLUGINS=false npx nx run source-web-articles:test
NX_DAEMON=false NX_ISOLATE_PLUGINS=false npx nx run source-web-articles:typecheck
```

The typecheck target includes formatting and lint. The discovery baseline passes. The pre-existing article baseline has 24 passing and three failing tests in `article-content-regressions.test.ts`: introductory summaries, linked figure captions, and acknowledgments/authorship disclosures. Those failures are tracked as **2919**, outside this source implementation. Article source code and those tests were left unchanged.

## Live verification — 2026-10-24

Every row below ran the new source against the actual input through a real pipeline into SQLite, using explicit include patterns for the same previously checked articles. A fresh source/pipeline instance then reran against the same destination and checkpoint store. All 26 stored articles retained identical HTML and text to the earlier extraction baseline; second runs emitted zero records and preserved all stored rows.

| Input                                   | Stored articles | First-run writes | Second-run writes |
| --------------------------------------- | --------------: | ---------------: | ----------------: |
| `https://www.anthropic.com/`            |               3 |                3 |                 0 |
| `https://simonwillison.net/`            |               3 |                3 |                 0 |
| `https://jvns.ca/`                      |               3 |                3 |                 0 |
| `https://blog.cloudflare.com/`          |               3 |                3 |                 0 |
| `https://blog.python.org/`              |               3 |                3 |                 0 |
| `https://martinfowler.com/`             |               3 |                3 |                 0 |
| `https://github.blog/`                  |               3 |                3 |                 0 |
| `https://www.jsonfeed.org/feed.json`    |               2 |                2 |                 0 |
| `https://daringfireball.net/feeds/main` |               3 |                3 |                 0 |

Evidence: `/tmp/elt-web-source-live/results.json`, with each site's SQLite destination, checkpoint file and result JSON beside it. Earlier extraction evidence: `/tmp/elt-2917/live-after.json`. The live process exited; no server or watcher is retained. Live publisher edits and injected failures were not attempted; controlled public HTTP tests cover updates, failure and cancellation.

These are scoped compatibility checks, not a complete crawl or throughput benchmark. Per-article snapshots rebuild and serialize accumulated fingerprint state, producing write amplification as listings grow; **2920** tracks package/engine-level improvement and benchmarking. Discovery buffers candidate URLs, and extraction buffers one response and parses synchronously. HTTP caching, retries, crawl delays, robots exclusion, authenticated pages and JavaScript rendering are not supplied by this source.

| Review disposition                                 | Outcome                                                          |
| -------------------------------------------------- | ---------------------------------------------------------------- |
| Missing website/feed end-to-end claim              | Fixed in regression 3 and live pipeline checks                   |
| Added-input continuity could pass after state loss | Fixed by preserving the existing feed during the added-input run |
| Large-listing checkpoint amplification             | Tracked as 2920; throughput remains unproven                     |
| Existing article-content losses                    | Tracked as 2919; source work preserves the baseline              |
| Mutation proof                                     | Not executed under repository/skill restrictions                 |

Only the reusable source is added here. Application settings and connector registration are a separate host task in `context-compiler`; this web source does not require Mac app access or a native-store connector.
