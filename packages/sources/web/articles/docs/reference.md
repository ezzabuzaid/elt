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

The source uses the engine's continued-scan snapshot comparison. Each processed page emits `STATE` containing the traversal cursor, accumulated opaque comparison state and failed page locations. The engine commits the preceding records before saving that full state. There is no source-specific hash, diff, writer, lock or checkpoint store.

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

Discovery reads the current listings on every run. Candidates are merged with saved failed page locations by URL, with fresh listing metadata taking precedence, then sorted and filtered by the caller's selection. During an interrupted incremental scan, `after` identifies the furthest processed URL, `diff` holds the engine's opaque comparison state, and `failed` holds the URL, listing URL and last-modified hint needed to retry each failed article. Earlier failed URLs are eligible even before `after`; completing their retries cannot rewind that cursor. Each processed page, including a failure or null extraction, emits the complete `STATE`. The engine commits prior rows before saving it. Finishing the scan clears `after` even when failures remain, so a permanently failing URL cannot prevent new URLs or updates earlier in the listing from being checked on subsequent refreshes.

An HTTP failure that exhausts Got's retry policy, or an extraction failure, produces the SDK's `ArticleError`. The source records it and continues other articles. After saving the completed scan state it throws a native `AggregateError` containing the original article errors and their causes. The engine exposes that through `PipelineError.results`, with the input partition and committed counts; the run remains explicitly incomplete. Saved failures are retried on a later run even after feed rollover. Successful retries, including a null extraction, remove their failed entry. A permanently failing page remains reported until it recovers or the caller changes selection. Cancellation retains committed progress, closes downloads and queued requests, and propagates the caller's exact reason. Discovery, validation, destination and checkpoint failures are outside the article catch; their existing engine semantics remain intact.

An absent listing entry is not proof of deletion: feeds routinely roll over. Incremental extraction declares no deletions and retains previously loaded rows, including when a later fetch returns no readable article. A full refresh has no incremental checkpoint and replaces the collection only on success. Removing an input or narrowing selection does not delete its already loaded rows in incremental mode; a full refresh rebuilds the chosen collection.

No load timestamp enters the source record, so an unchanged page does not create a false update. `publishedTime` and sitemap `lastModified` are raw upstream text, not inferred or normalized date fields. Missing extraction metadata is null. Downloads overlap with at most four article operations per input. pMapIterable bounds outstanding results and yields them in URL order; row validation and checkpoints remain sequential. Discovery holds candidate URLs and snapshots hold fingerprints. p-queue gates every initial, redirected and retried request at two starts per rolling second. Got’s 30-second request timeout starts after that gate, applies per attempt, and does not bound retry backoff or the entire scan. The caller can bound the whole run with an abort signal. Limits are per input scan, not shared across separate pipelines.

## Public regression ledger

Tests run through the exported `WebSource` module, a real `Pipeline`, the installed SDKs, real HTTP sockets and two independent package-owned SQLite databases. Controlled upstream pages are necessary to reproduce failures, cancellation and edits deterministically. No tests call publishers, seed checkpoint storage, replace internal modules, or use lifecycle hooks.

| Test claim                                                                                                      | First observed result                                                                         | Final result |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------ |
| Failed articles preserve successful rows; an interrupted scan skips already checkpointed downloads              | Red: no committed article table; extended with failure isolation and interrupted retry checks | Pass         |
| Cancellation preserves the exact reason, closes the download and retains resumable progress                     | Passed directly using existing fetch/engine behavior                                          | Pass         |
| Website and feed input persist body/metadata; unchanged reruns emit nothing; changed/new articles update/insert | Red: missing persisted metadata column                                                        | Pass         |
| Input failure isolation, added-input checkpoint continuity, null extraction and feed-rollover retention         | Passed using existing partition/diff behavior; strengthened after independent review          | Pass         |
| Failed full refresh retains the complete prior collection; recovery replaces it                                 | Red: unsupported full-refresh mode                                                            | Pass         |
| Pipeline watching refreshes edited articles and stops on cancellation                                           | Red: watcher not implemented                                                                  | Pass         |
| Explicit URL patterns prevent out-of-scope HTTP requests and preserve query variants                            | Red: excluded URL fetched and returned HTTP 503                                               | Pass         |

Independent `test-discoverer` and `test-claim-comparator` runs mapped the public seam and found the missing website/feed ingestion claim before implementation; that claim was added. The final comparator found no missing claims. The independent `test-gotcha-reviewer` found one evidence gap: rolling a completed feed to empty before adding inputs could hide discarded progress. The test now keeps that feed populated during extension, requires only two new writes, then rolls it over and requires zero writes with all three rows retained.

Mutation proof was not run: the write-test skill's supported procedure requires a repository copy, which this repository expressly prohibits; in-checkout mutation is also prohibited by that skill. Passing tests and observed red/green cycles are reported separately from mutation proof.

```sh
NX_DAEMON=false NX_ISOLATE_PLUGINS=false npx nx run source-web-articles:test
NX_DAEMON=false NX_ISOLATE_PLUGINS=false npx nx run source-web-articles:typecheck
```

The typecheck target includes formatting and lint. The unchanged-rerun regression observes the public `PassObserver` and requires every reported `emitted.count` to remain zero before destination deduplication. The 2925 checks below cover the current failure and retry behavior.

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

The temporary-listing/article recovery and request-rate tests each failed before their corresponding integration and then passed. The real HTTP boundary verifies that retries and redirects consume the same rate budget and Retry-After delays the next attempt. Additional regressions cover caller cancellation stopping streaming and queued requests after an article failure, and a slow first article bounding prefetch rather than downloading the whole feed. Source regressions also cover independent inputs, cancellation reasons, full-refresh rollback, URL selection and watching. SDK regressions cover injected download deadlines and non-retryable HTTP/extraction errors.

The live observations above include the HTTP scheduler and article extraction changes. They are scoped compatibility and rerun checks, not a sustained crawler throughput benchmark.

## Article extraction regression evidence

| Claim                                                                                                        | Observed red                                                                                    | Final result                                     |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Introductory summary, descriptive caption/link, acknowledgments and authorship disclosure survive extraction | Three public discovery/extraction tests failed on the original Readability selection            | Pass                                             |
| Inline punctuation and preformatted spacing are retained                                                     | Defuddle inserted a space in linked `HKDF-SHA-256` and removed the space before a ratio's colon | Pass with standardization disabled               |
| Ignored comments and surrounding whitespace do not create changed HTML                                       | Same prose produced different `content` strings                                                 | Pass with package-owned whitespace normalization |

Heading retention is an intentional extraction change; the paragraph-boundary regression asserts the complete exact output, including the heading. Short linked posts and tables remain covered. Mutation proof remains unexecuted under the repository/skill restrictions stated above.

## Failure isolation and durable retry — 2925

The backlog search covered open and completed items across repositories before implementation. Related web items were 2920 (deferred checkpoint write amplification), 2918 (representations/Markdown), 2924 (editorial asides), 2926 (sponsor and related-content pollution), 2927 (primary outbound links), and completed discovery/extraction fixes 2911–2915, 2917 and 2919. Only 2925 changes are implemented here; the SDK extraction work belongs to the separate task.

The installed p-map export, public `IterableOptions` and runtime were checked. `pMapIterable` throws when a mapper rejects and has no `stopOnError` option. An executable three-item probe yielded only `a` when `b` failed, despite `c` being independent. REJECTED: `pMap` with `stopOnError: false` and installed `pMapSettled`, because they collect the batch instead of yielding articles for bounded per-page checkpointing. REJECTED: `pMapSkip`, because omitting a failed result would omit its checkpoint and failure report. Got already owns HTTP retries; no retry library or worker queue is added. The engine's `Source.read` owns stream statuses and reports a thrown source error, so the source uses native `AggregateError` at scan completion rather than adding a message type.

Removed: propagation of one article's failure directly through the mapper and the test expectation that it cancels other articles. Retained: `pMapIterable` ordering/backpressure, Got retries, p-queue rate limiting, continued snapshot comparison, complete checkpoint saves, the public source constructor and engine/destination protocols. The additive code owns only URL retry state and article-error collection; the SDK identifies article errors, the source identifies pending URLs, and the engine commits and reports outcomes. No package, compatibility branch, publisher selector, patch journal or alternate store was added. The removal audit found no new wrapper, export or unused option to retain.

Public black-box evidence:

- Failure isolation first failed with one committed article instead of two. It now preserves the later completed article and reports the failed URL with the committed count.
- A permanent failure initially prevented a new URL before the previous cursor from loading (`0` new writes instead of `1`). Clearing the traversal cursor after the completed scan fixed that while retaining failed URLs separately.
- HTTP and extraction failures preserve their original URL/cause in the aggregate. Saved failed URLs survive feed rollover, a new pipeline, and cancellation during recovery.
- Two interrupted runs around an older failed URL leave successful later articles checkpointed; the final run downloads only the remaining unfinished article.
- Caller cancellation still closes streaming/queued requests with the original reason. Full refresh attempts later articles and retains the previous complete collection after any failure.

Final checks: 14 web-source, 36 ELT engine and 109 SQLite tests pass (159 total); the source's Nx typecheck, lint, formatting and dependent checks pass. The first full-suite attempt encountered a concurrent SQLite test missing `override`; its owning session corrected it before the successful rerun. No checkout copy or peer code reversion was used.

The final live run loaded all 26 selected articles across the same nine inputs in the earlier table. Eight inputs emitted and wrote zero records on rerun. Daring Fireball wrote one changed record: four subsequent public `WebArticle.fetch` captures showed alternating `sunnny-01.png` / `sunnny-02.png` sidebar advertising included in article HTML/text. This is extraction pollution related to 2926, not an article retry or checkpoint failure. The result is recorded as a failed unchanged-rerun assertion, not hidden as a successful stability check.

A separate controlled feed contained one HTTP 404 and three real Anthropic article URLs. All three live articles committed, with the failed URL reported. A fresh pipeline then recovered the retained URL after the feed rolled to empty; that recovery served a newly downloaded Anthropic page. The failure and recovery endpoint was controlled, not an induced failure on the publisher. [Live results, article hashes and the Daring difference](2925-live.json) retain the evidence; raw captures and databases are under `/tmp/elt-2925/`. All probe processes and HTTP fixtures exited. Complete-crawl throughput and publisher-side failure injection were not tested.

## Combined acceptance checks — 2026-10-24

The committed 2925 source and the separate, uncommitted extraction fixes for 2924, 2926 and 2927 were verified together in this checkout. [Combined evidence](2026-10-24-combined-checks.json) records the source/build hashes, input URLs, observed counts and scope. Source and extractor hashes remained unchanged during the live run. This section supersedes the earlier Daring Fireball unchanged-rerun failure for this tested combination; the historical failure evidence above is retained.

Each live input ran through `WebSource` → `Pipeline` → SQLite three times, with a new source/pipeline instance and the same destination/checkpoint files for each pass. The first pass stored 26 articles. Both subsequent passes emitted and wrote zero records, and every stored field remained identical.

| Live input      | Articles | Writes across three passes | Source emissions across three passes |
| --------------- | -------: | -------------------------- | ------------------------------------ |
| Anthropic       |        3 | 3, 0, 0                    | 3, 0, 0                              |
| Simon Willison  |        3 | 3, 0, 0                    | 3, 0, 0                              |
| Julia Evans     |        3 | 3, 0, 0                    | 3, 0, 0                              |
| Cloudflare      |        3 | 3, 0, 0                    | 3, 0, 0                              |
| Python Insider  |        3 | 3, 0, 0                    | 3, 0, 0                              |
| Martin Fowler   |        3 | 3, 0, 0                    | 3, 0, 0                              |
| GitHub Blog     |        3 | 3, 0, 0                    | 3, 0, 0                              |
| JSON Feed       |        2 | 2, 0, 0                    | 2, 0, 0                              |
| Daring Fireball |        3 | 3, 0, 0                    | 3, 0, 0                              |

The existing extraction benchmark independently fetched all 26 pages three times: 78 successful requests, stable HTML on every page, all 1,005 reference prose blocks, 39 table rows and 111 table cells retained, and zero matches for the known boilerplate checks. The primary painter tool link remains in HTML and text. Every public extractor field from these fresh captures exactly matched its persisted pipeline record. This re-verifies editorial asides (2924), sponsor/related-post exclusion including Daring ads (2926), and the primary outbound link (2927).

Updates and failures cannot be induced safely on publishers. Fresh original HTML from one page per site was therefore replayed through the installed `HttpServer`, the public source/pipeline APIs and persistent SQLite, with controlled changes only at that HTTP boundary:

- **Updates:** nine articles loaded; an unchanged pass emitted/wrote zero. Adding one verification paragraph to each captured article emitted/wrote nine updates, preserved nine rows, and stored every paragraph. The next unchanged pass emitted/wrote zero.
- **Interruption/resume:** cancellation after three committed articles propagated the exact reason. A fresh pipeline wrote the six remaining articles and made no requests for the three checkpointed pages. The next pass emitted/wrote zero.
- **Failure recovery:** a controlled 404 on the Anthropic capture reported the failed URL while the other eight articles committed. After the feed became empty, a fresh pipeline requested only the retained failed URL and stored its recovered article. The following pass emitted/wrote zero.

The existing Nx suites passed with 14 source and 37 article tests, zero failures and zero TODOs. They additionally cover cancellation during retries, extraction errors, repeated interruptions, independent inputs, rate limiting and full-refresh rollback. `nx run source-web-articles:typecheck` and its 23 dependent tasks passed, including formatting and lint.

The first source-test launch could not access the default fixture registry in the sandbox. The permitted launch then found an old Docker cleanup record while Docker was stopped. The package's documented `XDG_STATE_HOME` option isolated the HTTP/SQLite tests under `/tmp/elt-combined-e2e-GUb709/fixture-state`; existing recovery records were preserved, and the task registry was empty after teardown. No test setup or production code was changed.

Retained evidence is under `/tmp/elt-combined-e2e-GUb709/`: logs, databases, per-pass stored rows, fresh compressed publisher captures, scorer results and manifests. All runners and the replay server exited; temporary probe scripts were removed after verification. No source, SDK, engine, dependency or checkpoint mechanism changed in this verification task. Backlog 2918 (representations/Markdown) and 2920 (checkpoint write amplification) remain deferred and untouched. Full-crawl throughput, arbitrary-site extraction and publisher-side failure injection remain outside these sampled checks.
