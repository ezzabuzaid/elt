# Web source behavior and verification

## Ownership and package decisions

The upstream is the website or feed selected by the caller. The source reads it directly, not a dataset that the pipeline previously wrote. Package exports, options/types, and shipped runtime were read before implementation.

| Owner                               | Public API used                                                                | Responsibility                                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Web discovery SDK                   | `WebDiscovery.discover`                                                        | HTML/HTTP feed discovery, robots sitemap locations, sitemap/feed decoding and candidate deduplication                               |
| Web article SDK                     | `WebArticle.fetch`                                                             | HTTP, decoding, Defuddle content selection, Readability metadata, sanitization, text conversion, cancellation and attributed errors |
| Got 14.6.6                          | injected client, `extend`, `beforeRequest`                                     | HTTP retries, Retry-After, redirects, response bytes, cancellation and per-attempt timeouts                                         |
| p-map 7.1.1                         | `pMapIterable`                                                                 | Four concurrent articles, input-order results and bounded prefetching                                                               |
| p-queue 10.0.0                      | `add`, `intervalCap`, `interval`, `strict`, `onIdle`                           | Two request starts per rolling second, including retries and redirects; abortable queued work                                       |
| ELT engine                          | `Source`, `Stream`, `Catalog`, `validateRecords`                               | Stream contract, schema validation and independent input partitions                                                                 |
| ELT engine                          | `diffSnapshot(..., { continues: true })`                                       | New/changed record detection; delegates fingerprinting to installed `@zukhruf/snapshot-differential` 0.3.28                         |
| ELT engine/destination              | `Pipeline`, `Copy`, `Connection`, `SQLiteDestination`, `SQLiteCheckpointStore` | Commit ordering, deduplication, failure reporting, persistence, locking and full-refresh rollback                                   |
| Installed Zod 4.6.5                 | `z.url`, `z.array`, `z.object`, `parse`                                        | HTTP input validation, polling interval validation and checkpoint-envelope parsing                                                  |
| Node                                | `URLPattern`, `timers/promises.setInterval`, `AbortSignal`                     | Caller-defined URL selection, cancellable polling and request cancellation                                                          |
| Installed `@zukhruf/testing` 0.3.24 | `HttpServer.start`, `Sqlite.database`                                          | Real loopback HTTP and disposable SQLite fixtures                                                                                   |

The source uses the engine's continued-scan snapshot comparison. Each processed page emits `STATE` containing the last completed URL and the accumulated opaque comparison state. The engine commits the preceding records before saving that full state. There is no source-specific hash, diff, writer, lock or checkpoint store.

Full checkpoint saves rewrite the accumulated comparison state after each page. Reducing this write amplification is deferred in backlog item 2920; it is not required for resume or change detection.

REJECTED: using sitemap `lastmod` or feed publication timestamps to skip articles. They are optional hints and do not establish that an old page is unchanged. Successful reruns refetch selected pages and compare their extracted records.

REJECTED: `diffGroupedSnapshot` as a download-skipping shortcut. Generic websites do not supply reliable content fingerprints before fetching. Its capability was inspected; the required upstream guarantee is absent.

REJECTED: a new crawling framework for persistence or resume. The engine already supplies those jobs. Request scheduling and retries belong to p-map, p-queue and Got. Conditional fetching and crawl policy are not implemented.

RETAINED: the SDK return shapes, discovery behavior, and the engine's commit ordering, diff, partition isolation and destination behavior. Both SDK constructors require a configured Got client. The source owns the HTTP policy and passes the same client to discovery and extraction. A small native `Headers` conversion bridges Got response headers to Feedscout’s public API. Missing Readability metadata still becomes null in stream records. Defuddle now owns content selection; see the [article SDK decisions](../../../../sdks/web/article/README.md).

REJECTED: p-limit, because pMapIterable already supplies ordered concurrency and backpressure; p-retry, because Got supplies HTTP-aware retry rules, backoff and Retry-After. There is no custom worker pool, retry loop or result buffer. Node’s installed Readable.map declaration erases element/result types, so the typed iterable API fits the source without assertions or duplicate validation.

Removal audit: the article SDK delegates content selection and stable whitespace normalization to installed packages. Metadata rules, cancellation, partitioning and destination commit order remain intact. The source uses the existing full-state checkpoint protocol.

The extraction fix for 2919 is retained. Checkpoint write optimization is deferred under 2920.

## State, identity and failure behavior

`articles` declares `sourceDefinedCursor`, supports full refresh and incremental extraction, and uses `(inputUrl, pageUrl)` as its primary key. Each configured input is an engine-managed partition. Adding or reordering inputs preserves other inputs' progress. URLs preserve query and trailing-slash distinctions. Redirect targets and canonical declarations remain separate metadata.

Discovery reads the current listings on every run. Candidates are sorted by URL. During an incomplete incremental scan, `after` identifies the last processed URL and `diff` holds the engine's opaque comparison state. Each processed page, including a null extraction, emits the complete `STATE`. The engine commits prior rows before saving it. Finishing the scan clears `after`; destination rows remain untouched by listing disappearance. The next complete pass checks all selected candidates again.

An HTTP failure that exhausts Got’s retry policy stops that input and reports the failed URL through the SDK error. Other configured inputs can finish. Resume rediscovers listings and continues after the saved URL; changes or newly listed URLs at or before that cursor are revisited on the next complete scan. A permanently failing page remains a reported failure until upstream recovers or the caller changes its selection. Cancellation closes active downloads, removes queued requests, retains already committed records and propagates the caller's reason. The scan also aborts its work on failure or iterator closure. Prefetched results beyond a failed URL are never checkpointed and may be fetched again on resume.

An absent listing entry is not proof of deletion: feeds routinely roll over. Incremental extraction declares no deletions and retains previously loaded rows, including when a later fetch returns no readable article. A full refresh has no incremental checkpoint and replaces the collection only on success. Removing an input or narrowing selection does not delete its already loaded rows in incremental mode; a full refresh rebuilds the chosen collection.

No load timestamp enters the source record, so an unchanged page does not create a false update. `publishedTime` and sitemap `lastModified` are raw upstream text, not inferred or normalized date fields. Missing extraction metadata is null. Downloads overlap with at most four article operations per input. pMapIterable bounds outstanding results and yields them in URL order; row validation and checkpoints remain sequential. Discovery holds candidate URLs and snapshots hold fingerprints. p-queue gates every initial, redirected and retried request at two starts per rolling second. Got’s 30-second request timeout starts after that gate, applies per attempt, and does not bound retry backoff or the entire scan. The caller can bound the whole run with an abort signal. Limits are per input scan, not shared across separate pipelines.

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

The typecheck target includes formatting and lint. After removing the optimization, all 250 tests pass: 31 article, 12 web source, 36 engine, 108 SQLite and 63 PostgreSQL tests. PostgreSQL tests use real disposable databases. The unchanged-rerun regression also observes the public `PassObserver` and requires every reported `emitted.count` to remain zero before destination deduplication.

## Live verification — 2026-10-24

Every row below ran the new source against the actual input through a real pipeline into SQLite, using explicit include patterns for the same previously checked articles. A fresh source/pipeline instance then reran against the same destination and checkpoint store. The final 26-article comparison checks prior paragraphs of at least 50 characters against the new content rather than requiring the old extraction's omissions to remain. Second runs write zero records and preserve identical stored rows. The public regression above separately verifies zero source emissions. The new extractor retains headings, introductions, captions and appendices that the prior extractor could omit.

All compared paragraphs remain except four GitHub promotional paragraphs. A separate live DOM check confirms all four belong to an `aside` outside the article; their removal is intentional. Independent checks against the live Fowler pages preserve all 3 introductory summaries, 14 captions and 54 appendix paragraphs of at least 50 characters. The captured HTML and `github-quality.json` / `fowler.json` record those comparisons beside the results.

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

Evidence: `/tmp/elt-2919-2920/live-V55r2u/results.json`, with each site's SQLite destination, checkpoint file and result JSON beside it. Earlier baseline: `/tmp/elt-web-source-live/results.json`. The live process exited; no server or watcher is retained. Live publisher edits and injected failures were not attempted; controlled public HTTP tests cover updates, failure and cancellation. These live samples were recorded before the checkpoint optimization was removed; the removal is checked through the public local regression suites.

These are scoped compatibility checks, not a complete crawl or throughput benchmark. Checkpoint work grows with the accumulated listing; large-listing write amplification is tracked in 2920. Discovery buffers candidate URLs; extraction buffers response bytes and a bounded number of prefetched results, and parses synchronously. Got supplies HTTP retries. HTTP caching, crawl delays, robots exclusion, authenticated pages and JavaScript rendering are not supplied by this source.

| Review disposition                                 | Outcome                                                                |
| -------------------------------------------------- | ---------------------------------------------------------------------- |
| Missing website/feed end-to-end claim              | Fixed in regression 3 and live pipeline checks                         |
| Added-input continuity could pass after state loss | Fixed by preserving the existing feed during the added-input run       |
| Large-listing checkpoint amplification             | Deferred in backlog item 2920; full checkpoint saves remain            |
| Existing article-content losses                    | Fixed through Defuddle; content, short-post and table regressions pass |
| Mutation proof                                     | Not executed under repository/skill restrictions                       |

Application settings and connector registration belong to the host in `context-compiler`; this reusable web source does not require Mac app access or a native-store connector.

## HTTP scheduling regression coverage

The temporary-listing/article recovery, out-of-order failure/resume, and request-rate tests each failed before their corresponding integration and then passed. The real HTTP boundary verifies that retries and redirects consume the same rate budget and Retry-After delays the next attempt. Additional regressions cover failure cancelling both streaming and queued requests, and a slow first article bounding prefetch rather than downloading the whole feed. Existing source regressions still cover independent inputs, cancellation reasons, full-refresh rollback, URL selection and watching. SDK regressions cover injected download deadlines and non-retryable HTTP/extraction errors.

The live observations above include the HTTP scheduler and article extraction changes. They are scoped compatibility and rerun checks, not a sustained crawler throughput benchmark.

## Article extraction regression evidence

| Claim                                                                                                        | Observed red                                                                                    | Final result                                     |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Introductory summary, descriptive caption/link, acknowledgments and authorship disclosure survive extraction | Three public discovery/extraction tests failed on the original Readability selection            | Pass                                             |
| Inline punctuation and preformatted spacing are retained                                                     | Defuddle inserted a space in linked `HKDF-SHA-256` and removed the space before a ratio's colon | Pass with standardization disabled               |
| Ignored comments and surrounding whitespace do not create changed HTML                                       | Same prose produced different `content` strings                                                 | Pass with package-owned whitespace normalization |

Heading retention is an intentional extraction change; the paragraph-boundary regression asserts the complete exact output, including the heading. Short linked posts and tables remain covered. Mutation proof remains unexecuted under the repository/skill restrictions stated above.
