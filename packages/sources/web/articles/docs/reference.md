# Web source behavior and verification

## Ownership and package decisions

The upstream is the website or feed selected by the caller. The source reads it directly, not a dataset that the pipeline previously wrote. Package exports, options/types, and shipped runtime were read before implementation.

| Owner                               | Public API used                                                                           | Responsibility                                                                                                                                       |
| ----------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web crawler SDK                     | `WebCrawler.run/resume`, `Crawl.snapshot`, `ListingReader`, `ArchiveReader`, `LinkReader` | Feeds, sitemaps, archives and bounded ordinary-link crawling; one download per found URL; candidate metadata, deduplication and resumable progress   |
| Web article SDK                     | `WebArticle.read`, `accept`                                                               | Representation choice, decoding, Defuddle content selection, Readability metadata, sanitization, text conversion, cancellation and attributed errors |
| Got 14.6.6                          | injected client, `extend`, `cache`, `beforeRequest`, `afterResponse`                      | HTTP retries, Retry-After, redirects, conditional requests, cache policy, response bytes, cancellation and per-attempt timeouts                      |
| p-queue 10.0.0                      | `add`, `intervalCap`, `interval`, `strict`, `onIdle`                                      | Two request starts per rolling second, including retries and redirects; abortable queued work                                                        |
| ELT engine                          | `Source`, `Stream`, `Catalog`, `validateRecords`                                          | Stream contract, schema validation and independent input partitions                                                                                  |
| ELT engine                          | `diffGroupedSnapshot(..., { continues: true })`                                           | New/changed record detection; delegates fingerprinting to installed `@zukhruf/snapshot-differential` 0.3.28                                          |
| ELT engine/destination              | `Pipeline`, `Copy`, `Connection`, `SQLiteDestination`, `SQLiteCheckpointStore`            | Commit ordering, deduplication, failure reporting, persistence, locking and full-refresh rollback                                                    |
| Installed Zod 4.6.5                 | `z.url`, `z.array`, `z.object`, `parse`                                                   | HTTP input validation, polling interval validation and checkpoint-envelope parsing                                                                   |
| Node                                | `URLPattern`, `timers/promises.setInterval`, `AbortSignal`                                | Caller-defined URL selection, cancellable polling and request cancellation                                                                           |
| Installed `@zukhruf/testing` 0.3.24 | `HttpServer.start`, `Sqlite.database`                                                     | Real loopback HTTP and disposable SQLite fixtures                                                                                                    |

The source uses the engine's continued-scan snapshot comparison. Each processed page emits `STATE` with three parts: `diff`, the engine's opaque comparison state; `crawl`, the crawler snapshot of the unfinished crawl, or null when the crawl is complete; and `retry`, the failed page locations. The engine commits the preceding records before it saves that state. The source hashes the SDK input fingerprint together with listing URL and last-modified metadata; the engine owns group comparison and committed state. There is no source-specific diff, writer, lock or checkpoint store.

Full checkpoint saves rewrite the accumulated comparison state and the crawl snapshot after each page. Reducing this write amplification is deferred in backlog item 2920; it is not required for resume or change detection.

REJECTED: using sitemap `lastmod` or feed publication timestamps to skip articles. They are optional hints and do not establish that an old page is unchanged. Successful reruns revalidate selected pages and compare their complete input fingerprints before extraction.

RETAINED: `diffGroupedSnapshot` for incremental computation after download. Each discovered URL is one group. Its lazy records callback extracts only when the SDK response fingerprint or listing metadata changes, or when committed state is absent. Matching groups retain their records without extraction; full refresh always extracts. Null SDK fingerprints keep alternate/fallback representations eligible because their additional responses can change independently. This skips extraction, not HTTP requests.

REJECTED: crawl scheduling in the source. The crawler SDK owns the frontier, deduplication, link limits and resumable snapshots. Got owns retries and conditional fetching; p-queue owns the request rate.

RETAINED: the article SDK return shapes and the engine's commit ordering, diff, partition isolation and destination behavior. The HTTP module owns HTTP policy; the source passes its configured client to the crawler and the article reader. A Got `beforeRequest` hook sets the article reader's `accept` header on the pages that the crawl hands back (`options.context.page`). Missing Readability metadata still becomes null in stream records. Defuddle owns content selection; see the [article SDK decisions](../../../../sdks/web/article/README.md).

REJECTED: concurrent downloads in the source. The crawler downloads one page at a time; the gate of two request starts per second is the bottleneck.

Removal audit: the article SDK delegates content selection and stable whitespace normalization to installed packages. Metadata rules, cancellation, partitioning and destination commit order remain intact. The source uses the existing full-state checkpoint protocol.

The extraction fix for 2919 is retained. Checkpoint write optimization is deferred under 2920.

## Persistent HTTP cache

The HTTP module owns `.cache/web-http.sqlite` under the working directory and creates the cache directory automatically. `WebSource` has no cache path option. Each input scan opens Keyv 6.1.0 with the official `@keyv/sqlite` 6.1.0 adapter and explicitly selects `driver: 'node:sqlite'`. The HTTP module creates the directory and file with owner-only permissions and closes the cache through Keyv's public `disconnect()` when extraction ends. Cache errors cancel the scan. Got owns validators, response restoration and HTTP cache policy; Keyv and its adapter own serialization, expiry and SQLite storage.

Got 14.6.6 and cacheable-request 13.0.19 still declare Keyv 5 dependencies; even Got 16.1.0, the latest published release checked, declares Keyv 5. The root manifest therefore scopes Keyv 6.1.0 overrides to Got and cacheable-request. This keeps the HTTP cache on one Keyv implementation without runtime compatibility code or changing Got. The dependency graph is valid; Keyv 5 remains only under ESLint's cache tooling. These overrides go beyond upstream's declared version ranges and are verified against this repository's web source and SDKs, not every Got use case.

The 35-line lifecycle class, its set/delete forwarding methods, write queue and two drain calls are removed. The official Node driver executes SQLite statements synchronously. The existing cold-write-error and no-store regressions pass without a drain; a new public regression also drops the cache table during 304 revalidation and requires the pipeline to fail while unchanged extraction is skipped. The HTTP module retains the cache error listener; the source retains its final abort check. `Source.open()` returns an empty `AsyncDisposableStack`, as its contract prescribes when there is no shared upstream snapshot. The cache is transport state: the HTTP module opens it for each extraction and registers `disconnect()` with that extraction’s scoped `AsyncDisposableStack`. The cache is neither augmented with disposal methods nor passed through the source context. A configured Got client remains the SDK dependency. Persistence, independent input progress, cancellation and storage failures passed the existing 27-test source suite before and after this ownership change; the Nx typecheck, lint and formatting also passed.

The adapter's public `driverName` was observed as `node:sqlite`, and the runtime probe loaded no SQLite native addon. The old `sqlite3` dependency is removed. The official adapter still declares `better-sqlite3` for its other drivers, so that dependency remains installed even though this configuration does not load it. No dependency payload filtering, schema migration code, custom SQL, body comparison or new HTTP/cache package was added. The existing fingerprint/diff behavior, rate limiter and file permissions remain intact.

The persistence and error constraints introduced in `b562c7e1` are retained. The change reaches one production cache consumer, its public pipeline tests, dependency declarations and documentation. REJECTED: keeping the lifecycle queue once the native-driver regressions pass. REJECTED: retaining the sqlite3-based adapter or introducing a type cast, runtime compatibility wrapper or Got fork to connect the versions. Self-audit found no added fallback configuration or compatibility branches. No active-scope decision is unresolved.

The native-cache upgrade passed `nx run source-web-articles:typecheck` (including formatting and lint) and the complete source, article SDK and discovery SDK suites: 25 + 66 + 29 = 120 tests. Coverage includes persisted responses across processes, ETag and Last-Modified revalidation, compressed bodies, Markdown negotiation, no-store eviction, fresh checkpoints, full refresh and cache write failures on both cold and 304 paths. The upgrade removes 28 net production lines relative to the sqlite3 adapter with its lifecycle class; the added 304 case exercises the public pipeline rather than adapter internals. The final focused rerun verifies that both cold and 304 failures are reported through `PipelineError`; the final typecheck and a subsequent complete 27-test source rerun also passed after the concurrent discovery changes. Temporary upgrade probes, databases and logs were removed.

### Earlier sqlite3 adapter comparison — 2026-10-25

The following measurements compare the original custom implementation with `@keyv/sqlite` 4.0.8 using `sqlite3`. They are historical results, not performance measurements of the current Keyv 6/node:sqlite configuration.

The comparison captured 35 responses (26 article pages plus nine listings) from nine public sites once, with no capture failures. Both adapters received the same 1,347,418 bytes of compressed or uncompressed response bodies. The storage comparison reopened the database each round, read and updated every cached policy, and alternated adapters over 16 measured rounds after two warmups. A separate SQL-trigger pass counted changed row payloads without instrumenting timed rounds.

| Per 35-response storage pass         |  Custom adapter | Official adapter |
| ------------------------------------ | --------------: | ---------------: |
| Median elapsed time                  |        10.39 ms |         13.32 ms |
| Median process CPU                   |         9.04 ms |         12.65 ms |
| Logical bytes written                |          15,306 |        1,812,544 |
| Rows containing body bytes rewritten |               0 |               35 |
| Database file size after measurement | 1,421,312 bytes |  1,851,392 bytes |

The pipeline comparison replayed the captured 26 articles through a local HTTP server and one RSS listing. It used the real Pipeline, SQLite destination and checkpoints, four concurrent downloads and the production two-request-starts-per-second limit. Each scan ran in a new Node process. HTML-only extraction was fixed for both adapters; discovery followed the fixture feed. After each adapter's cold scan, five alternating repeat scans revalidated all 27 responses.

| Per 26-article repeat poll | Custom adapter | Official adapter |
| -------------------------- | -------------: | ---------------: |
| Median elapsed time        |   13,043.62 ms |     13,041.04 ms |
| Median process CPU         |      184.61 ms |        214.81 ms |
| New article records        |              0 |                0 |

A final confirmation ran the adopted implementation, including write draining, through a cold scan and five more repeat scans. Its median was 13,043.88 ms elapsed and 240.29 ms CPU, with 135/135 repeat responses returning 304 and zero new records. All stored article fields matched the original baseline after excluding load timestamps and normalizing the replay server’s ephemeral port. This confirmation was sequential after the alternating comparison, not an additional alternating sample.

All 270 repeat responses returned 304. All 26 article records matched between adapters, excluding the destination's load timestamp, and remained unchanged through every repeat. The approximately 3 ms storage-pass difference does not justify custom SQLite storage for this workload. CPU measurements varied across runs; the timing comparison does not establish a CPU speedup for either adapter. SQL payload bytes are logical writes, not physical disk traffic or SSD wear. This was controlled replay of real response bytes, not live-network timing, full-site crawling or a native-Markdown throughput benchmark. Temporary captures, benchmark scripts, databases and processes were cleaned up after verification.

## State, identity and failure behavior

`articles` declares `sourceDefinedCursor`, supports full refresh and incremental extraction, and uses `(inputUrl, pageUrl)` as its primary key. Each configured input is an engine-managed partition. Adding or reordering inputs preserves other inputs' progress. URLs preserve query and trailing-slash distinctions. Redirect targets and canonical declarations remain separate metadata.

Each run resumes the saved crawl snapshot. When the last crawl completed, the run starts a new crawl from the input and hands the saved failures back as known pages. The crawl reads listings before pages, so listing metadata takes precedence over links. Each handed-back page, including a failure or a null extraction, emits the complete `STATE`. The page handed out last stays pending in the snapshot until the next page is requested, so an interrupted run repeats at most that page, and the diff skips its unchanged records. A completed crawl saves `crawl: null`.

A download or listing failure that exhausts Got's retry policy produces the crawler's `CrawlError`; an extraction failure produces the SDK's `ArticleError`. The source records it and the crawl continues. After saving the completed state, the source throws a native `AggregateError` containing the original errors and their causes. The engine exposes that through `PipelineError.results`, with the input partition and committed counts; the run remains explicitly incomplete. Saved failures are retried on a later run even after feed rollover. A successful retry, including a null extraction, removes its entry. A permanently failing page remains reported until it recovers or the caller changes selection. Cancellation retains committed progress, closes downloads and queued requests, and propagates the caller's exact reason. Validation, destination and checkpoint failures are outside the catch; their engine semantics remain intact.

An absent listing entry is not proof of deletion: feeds routinely roll over. Incremental extraction declares no deletions and retains previously loaded rows, including when a later fetch returns no readable article. A full refresh has no incremental checkpoint and replaces the collection only on success. Removing an input or narrowing selection does not delete its already loaded rows in incremental mode; a full refresh rebuilds the chosen collection.

No load timestamp enters the source record, so an unchanged page does not create a false update. `publishedTime` and sitemap `lastModified` are raw upstream text, not inferred or normalized date fields. Missing extraction metadata is null. The crawler downloads one page at a time per input and holds its frontier in memory; snapshots hold fingerprints and the frontier. p-queue gates every initial, redirected and retried request at two starts per rolling second. Got’s 30-second request timeout starts after that gate, applies per attempt, and does not bound retry backoff or the entire scan. The caller can bound the whole run with an abort signal. Limits are per input scan, not shared across separate pipelines.

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

These are scoped compatibility checks, not a complete crawl or throughput benchmark. Checkpoint work grows with the accumulated listing; large-listing write amplification is tracked in 2920. Discovery buffers candidate URLs; extraction buffers response bytes and a bounded number of prefetched results, and parses synchronously. Got supplies HTTP retries. Crawl delays, robots exclusion, authenticated pages and JavaScript rendering are not supplied by this source.

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

Public black-box evidence:

- Failure isolation first failed with one committed article instead of two. It now preserves the later completed article and reports the failed URL with the committed count.
- A permanent failure initially prevented a new URL before the previous cursor from loading (`0` new writes instead of `1`). Clearing the traversal cursor after the completed scan fixed that while retaining failed URLs separately.
- HTTP and extraction failures preserve their original URL/cause in the aggregate. Saved failed URLs survive feed rollover, a new pipeline, and cancellation during recovery.
- Two interrupted runs around an older failed URL leave successful later articles checkpointed; the final run downloads only the remaining unfinished article.
- Caller cancellation still closes streaming/queued requests with the original reason. Full refresh attempts later articles and retains the previous complete collection after any failure.

Final checks: 14 web-source, 36 ELT engine and 109 SQLite tests pass (159 total); the source's Nx typecheck, lint, formatting and dependent checks pass. The first full-suite attempt encountered a concurrent SQLite test missing `override`; its owning session corrected it before the successful rerun. No checkout copy or peer code reversion was used.

The final live run loaded all 26 selected articles across the same nine inputs in the earlier table. Eight inputs emitted and wrote zero records on rerun. Daring Fireball wrote one changed record: four subsequent public `WebArticle.fetch` captures showed alternating `sunnny-01.png` / `sunnny-02.png` sidebar advertising included in article HTML/text. This is extraction pollution related to 2926, not an article retry or checkpoint failure. The result is recorded as a failed unchanged-rerun assertion, not hidden as a successful stability check.

A separate controlled feed contained one HTTP 404 and three real Anthropic article URLs. All three live articles committed, with the failed URL reported. A fresh pipeline then recovered the retained URL after the feed rolled to empty; that recovery served a newly downloaded Anthropic page. The failure and recovery endpoint was controlled, not an induced failure on the publisher. The generated JSON report was removed during benchmark cleanup; this summary retains the findings. All probe processes and HTTP fixtures exited. Complete-crawl throughput and publisher-side failure injection were not tested.

## Combined acceptance checks — 2026-10-24

The committed 2925 source and the separate, uncommitted extraction fixes for 2924, 2926 and 2927 were verified together in this checkout. Source and extractor hashes remained unchanged during the live run. The generated JSON report was removed during benchmark cleanup; the observed counts and scope remain below. This section supersedes the earlier Daring Fireball unchanged-rerun failure for this tested combination; the historical failure summary above is retained.

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

## Archive discovery and Markdown — 2026-10-24

The current source follows the crawler's advertised HTML archives, year/month indexes and feed pagination. It stores `markdown` alongside sanitized `content` and `textContent`. The article SDK calls `NodeHtmlMarkdown.translate` after sanitization, preserving the same selected body in all three representations. No publisher branch or JavaScript rendering was added.

Public black-box TDD observed failures before adding archive traversal, calendar history, feed pagination, HTTP pagination/redirect handling, content-index labels, dead-archive handling, Markdown output, literal-HTML escaping and the source schema field. The final suites passed: 16 discovery tests, 40 article tests and 15 source tests. The source's real HTTP/Pipeline/SQLite test discovers an older archive article, persists its exact Markdown and writes zero records on an unchanged rerun. The source Nx typecheck and all 23 dependencies passed, including formatting and lint.

The fixed 26-article corpus across Anthropic, Simon Willison, Julia Evans, Cloudflare, Python Insider, Martin Fowler, GitHub, JSON Feed and Daring Fireball was fetched three times through the built public article API: 78/78 succeeded, with stable extracted HTML for all 26 pages. Independent publisher references retained 1,005/1,005 prose blocks, 39/39 table rows and 111/111 table cells. Median download-plus-extraction time was 227 ms and p95 was 729 ms; these are observations from this run, not a speedup claim.

A separate **round-trip check** rendered the returned Markdown with Marked and compared it with the returned sanitized HTML. It retained all 1,224 extracted leaf text blocks, 42 table rows and 292 link destinations. Link comparison decodes URI escapes while preserving reserved separators; whitespace and Unicode normalization apply to text comparisons. Public regressions separately check exact code whitespace, literal backtick fences, escaped HTML prose, headerless tables, pipe-containing cells and short linked posts. These checks demonstrate conversion fidelity for this corpus, not universal extraction completeness.

Package exports, types and shipped implementations were read first. The already-installed jsdom, Feedscout and Feedsmith own parsing and URL/format handling. `node-html-markdown` owns Markdown rendering; Marked is test-only. Defuddle's early conversion/browser-only helper and Turndown's insufficient table handling were rejected after executable probes. This change adds the requested behavior; it is not claimed as a net code deletion. Existing metadata, null extraction, attributed errors, cancellation and source checkpoint behavior remain intact.

Benchmark scripts and captures were run in temporary scratch and removed after verification, as requested. No benchmark harness or captured website content is retained as part of this change. Durable regression fixtures remain in the test files. Native publisher Markdown negotiation and universal archive coverage were not implemented or claimed.

Live discovery started from each site's HTML root (Anthropic used its news index), followed every advertised listing reachable under these rules, and finished successfully for all nine inputs. Request starts were limited to two per second per site, with no retries, a 30-second request deadline and a 15-minute whole-site deadline. Counts include candidate category/resource links; they are not extracted article counts.

| Site       | Unique candidates | HTTP listing responses | Seconds |
| ---------- | ----------------: | ---------------------: | ------: |
| anthropic  |               582 |                      3 |     1.2 |
| simon      |            28,645 |                    960 |   580.7 |
| julia      |               772 |                      4 |     2.0 |
| cloudflare |            10,210 |                     12 |     8.6 |
| python     |               830 |                     22 |    19.1 |
| fowler     |               978 |                      5 |     2.8 |
| github     |             9,665 |                     32 |    18.4 |
| jsonfeed   |                 2 |                     13 |    11.5 |
| daring     |             1,960 |                      5 |     2.0 |

The first live pass exposed a dead Simon archive link that discarded valid history and Fowler's “All Content” index that was missed. Both became failing public regressions before generic fixes. The final Simon traversal completed all 960 reachable listing responses, including pagination within months, and tolerated the dead archive's 404. This measures the cost of full backfill; it does not establish universal website completeness or article-load throughput.

A final audit found that the initial calendar pattern also treated ordinary words such as `talks` and `xtech` as month names. A public regression first failed because `/2001/essays/` was downloaded as a listing instead of returned as an article candidate. The matcher now uses numeric months 1–12 and English month names generated by the platform. All discovery tests and the source typecheck passed again. Replaying the freshly captured response bodies/status/content types through the public HTTP boundary, with uncaptured redirect aliases fetched live, preserved all 26 corpus URLs. Eight sites' candidate sets were unchanged; Simon's final count is 28,643: two ordinary page URLs became candidates and four links inside a mistakenly traversed demo page disappeared. The table above records the full live sweep before this last narrowing, not a second ten-minute crawl.

A concurrent extraction-chain refactor preserved the conversion in the shared `Extraction` base and changed construction to `new WebArticle([new HTMLExtraction()], http)`. The public article suite passed all 45 tests, including the three Markdown regressions. A fresh 78-request live run through that constructor returned article objects exactly equal to the preceding 26-page run, and the Markdown round-trip counts stayed 1,224 blocks, 42 rows and 292 links with zero losses. The 15 source tests and source typecheck passed again after the refactor; with the 16 discovery tests, the current checked total is 76. No temporary benchmark process or artifact from this task remains.

## Native Markdown preference — 2026-10-24

The source now configures `MarkdownExtraction` before `HTMLExtraction`. Content negotiation uses the HTTP `Accept` header to prefer Markdown, like choosing a language with `Accept-Language`. The reader also follows explicit Markdown alternatives in HTTP Link headers and HTML link elements. Optional alternative failures preserve the fetched HTML; rejected or unusable negotiated Markdown gets one HTML-only attempt. There is no publisher-specific route, guessed `.md` endpoint or JavaScript renderer.

Marked parses Markdown; gray-matter separates front matter; its public YAML engine delegates to the installed YAML 1.2 parser so dates remain raw strings. DOMPurify sanitizes rendered HTML; html-to-text supplies text and table formatting. Native Markdown body text is preserved verbatim after removing front matter. It can contain raw HTML and publisher boilerplate, so a later renderer must sanitize its output. The shared `Extraction` contract remains format-neutral and now requires `mediaTypes`; HTML-only readers still work.

Public TDD observed native preference returning HTML, front-matter title loss, missed advertised alternatives, rejected plain-text `.md` files, HTTP 406 failure and HTML-only pipeline output before their fixes. Controls cover tables, short links, exact code text, charset decoding, malformed/empty alternatives, redirects/base URLs, cancellation, disabled executable front matter and an unchanged pipeline rerun. Tests use the public reader and real HTTP/Pipeline/SQLite boundaries.

Fresh live SDK verification used the following 17 articles from the same nine websites, rather than claiming the earlier 26-page corpus. All 17 succeeded in one request each. Both Cloudflare responses were `text/markdown`; their Markdown bodies exactly matched the server body after package-owned front-matter removal. All 15 HTML results were deeply equal to the existing `HTMLExtraction` result from the same downloaded bytes.

| Article                                                                                                                                                                                            | Representation  | Tables / cells | Milliseconds |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | -------------: | -----------: |
| [Investing in the public benefit](https://www.anthropic.com/news/public-benefit-fund)                                                                                                              | HTML fallback   |          0 / 0 |          446 |
| [Expanding the Cyber Verification Program](https://www.anthropic.com/news/cyber-verification-program)                                                                                              | HTML fallback   |          0 / 0 |          310 |
| [Release: battledrones v14: Compass Rose, a four player map](https://simonwillison.net/2026/Oct/24/battledrones/)                                                                                  | HTML fallback   |          0 / 0 |          111 |
| [Tool: Quick Study](https://simonwillison.net/2026/Oct/23/quick-study-painter/)                                                                                                                    | HTML fallback   |          0 / 0 |           41 |
| [Replacing the old battery on rechargeable bike lights](https://jvns.ca/blog/2026/09/27/replacing-the-old-battery-on-rechargeable-bike-lights/)                                                    | HTML fallback   |          0 / 0 |          483 |
| [Some more things about Django I've been enjoying](https://jvns.ca/blog/2026/07/21/more-nice-django-things/)                                                                                       | HTML fallback   |          0 / 0 |          126 |
| [Python 3.16.0 alpha 1 is now available \| Python Insider](https://blog.python.org/2026/10/python-3160-alpha-1-is-now-available)                                                                   | HTML fallback   |          0 / 0 |         1141 |
| [Python 3.15.0 (final) is here! \| Python Insider](https://blog.python.org/2026/10/python-3150-final-is-here)                                                                                      | HTML fallback   |          0 / 0 |          878 |
| [When Software Meets Hardware](https://martinfowler.com/articles/software-meets-hardware.html)                                                                                                     | HTML fallback   |         1 / 28 |          700 |
| [Build your slide template](https://martinfowler.com/articles/never-send-slides/build-your-slide-template.html)                                                                                    | HTML fallback   |         2 / 29 |          509 |
| [The bridge to agent-scale Git infrastructure](https://github.blog/engineering/architecture-optimization/the-bridge-to-agent-scale-git-infrastructure/)                                            | HTML fallback   |          0 / 0 |          763 |
| [How 3 Java Champions are using GitHub Copilot for increased productivity](https://github.blog/ai-and-ml/github-copilot/how-3-java-champions-are-using-github-copilot-for-increased-productivity/) | HTML fallback   |          0 / 0 |          357 |
| [Origin Range Requests: Serving large files without range-request tuning](https://blog.cloudflare.com/origin-range-requests/)                                                                      | Native Markdown |          0 / 0 |          229 |
| [Bringing post-quantum cryptography to geographically fenced key management](https://blog.cloudflare.com/post-quantum-geo-key-manager/)                                                            | Native Markdown |          0 / 0 |           96 |
| [JSON Feed - JSON Feed version 1.1](https://www.jsonfeed.org/2020/08/07/json-feed-version.html)                                                                                                    | HTML fallback   |          0 / 0 |          614 |
| [JSON Feed - Announcing JSON Feed](https://www.jsonfeed.org/2017/05/17/announcing-json-feed.html)                                                                                                  | HTML fallback   |          0 / 0 |          187 |
| [The iPhone Duo](https://daringfireball.net/2026/10/the_iphone_duo)                                                                                                                                | HTML fallback   |         3 / 34 |          425 |

The sample includes Simon’s short linked Quick Study post, six extracted HTML tables and 91 table cells. Native tables and exact fenced-code whitespace are covered by the public deterministic test, because these two live Cloudflare articles contained no tables. Median fetch-plus-extraction time was 425 ms; the maximum was 1141 ms. These are observations, not comparative speed claims.

Cloudflare’s native Markdown retained “Skip to content”, home links and other site navigation, and supplied no structured author/date fields, so those fields are null. Native availability is therefore not proof of better article cleanliness or metadata. The other sampled responses exposed no Markdown alternative under the implemented negotiation/declaration rules; this does not establish that no Markdown exists elsewhere on those websites.

No existing extraction mechanism was removed. The change is additive; handwritten Markdown/YAML/link parsers were avoided. REJECTED `front-matter` 4.0.2 after its callable type failed under NodeNext; it was removed from the dependency graph. REJECTED gray-matter’s date-coercing default YAML engine and executable JavaScript engine. Existing HTML selection, metadata and cancellation behavior remain covered. HTTP transport/cache changes in the concurrent chat are separate work.

Removal audit snapshot: the touched-path diff contains 905 added and 93 deleted lines, including both new Markdown files and concurrent cache edits in shared files; it is net-additive, justified by the requested format and negotiation support. No existing extraction behavior was deleted. Package-owned parsing replaced no pre-existing local parser. The rejected front-matter experiment is absent from the manifest/lockfile. No new generic registry, compatibility shim, custom Markdown translator or unused option remains. All scratch probes are temporary. No equivalence claim is made for native-vs-HTML metadata or cleanliness; HTML fallback parity is observed. The native quality follow-up is recorded as backlog 2941; no user decision is pending.

Final verification: all 58 article tests and 18 source tests passed, with zero failures, skips or TODOs; these totals include the concurrent lazy-download regressions. The source Nx typecheck, lint, formatting and 23 dependent tasks passed. A second fresh live pass after that download refactor returned articles deeply equal to the first pass for all 17 URLs (34 successful article requests across the two passes). This verifies the SDK live and persistence through deterministic public Pipeline/SQLite tests; it is not a new full-site discovery crawl. Probe scripts, logs and captures were removed from temporary scratch after verification; no benchmark artifact was added to the repository.

## Native Markdown normalization (2941) — 2026-10-24

The two Cloudflare URLs in the table above reproduced the defect before editing: native `textContent` included skip/home navigation, footer material and serialized JSON-LD, and `publishedTime` was null. Rendering the complete Markdown as HTML and passing it to installed Defuddle (default options and `standardize: false`) or Readability did not recover the lost semantic boundaries: both retained navigation and JSON-LD prose. Their existing extraction from the actual HTML counterpart already isolated the article and found the publication metadata.

The fix separates source fidelity from normalization. `markdown` still contains the exact native body after front-matter removal, including any publisher boilerplate. A readable HTML counterpart supplies selected/sanitized `content`, `textContent` and `length`; its metadata fills only null/undefined native fields. Advertised Markdown reuses the already downloaded HTML. Negotiated Markdown requests the final URL once more with an HTML-only Accept header. An unavailable, incompatible or unreadable companion leaves the native result intact. Cancellation propagates unchanged. Markdown-only readers and direct plain-text Markdown files retain their existing behavior.

Scope: replace the successful-native early returns in `WebArticle`; keep `MarkdownExtraction`, `HTMLExtraction`, their public exports and dependencies, and the source schema. The sole production caller is `WebSource`. No publisher route, custom Markdown classifier, extra public option or new dependency was introduced. Got, Defuddle, Readability and the existing converters retain their jobs. REJECTED reconstructing article boundaries from raw Markdown tokens: Marked exposes parsing/raw tokens, not article isolation, and the executable package probes failed to remove the observed clutter. REJECTED reserializing native Markdown because that would break its raw-source contract. Metadata absence is explicit in Readability's shipped `_getArticleMetadata`/`parse` implementation; the merge's nullish choices preserve native values rather than invent defaults.

Public red/green tests first reproduced polluted normalized text through both negotiated and advertised Markdown. They now verify clean text, native metadata precedence, HTML metadata enrichment, original-response reuse, unchanged native source, short linked prose, table cells and code indentation. Additional controls cover unavailable/empty/wrong-type/malformed-XHTML companions and exact cancellation reasons. The real WebSource → Pipeline → SQLite test verifies clean stored text, author/date enrichment, zero writes on an unchanged rerun, and a subsequent HTML date edit being saved even though the Markdown bytes did not change. Multi-response downloads retain a null fingerprint so independent companion changes cannot be skipped.

A fresh live rerun covered all 17 URLs in the table above across Anthropic, Simon Willison, Julia Evans, Python, Martin Fowler, GitHub, Cloudflare, JSON Feed and Daring Fireball. All 15 HTML-only results were deeply equal to a separate HTML-only fetch. Both native results retained exact source Markdown, while their normalized HTML/text/length equalled a separate HTML-only extraction and excluded skip/home navigation and serialized JSON-LD. The sample retained Simon's short linked post, six tables and 91 cells. Across the preferred reader's 19 requests, median fetch-plus-extraction time was 342 ms and maximum was 847 ms; these are one-pass observations, not comparative performance claims.

| Native page                  | Text length before → after | Publication metadata after | Preferred-reader time |
| ---------------------------- | -------------------------: | -------------------------- | --------------------: |
| Origin Range Requests        |            17,304 → 12,165 | `2026-10-23T18:22:59.215Z` |                195 ms |
| Post-quantum Geo Key Manager |            25,318 → 21,138 | `2026-10-23T18:06:56.089Z` |                236 ms |

Neither live HTML page declared an author, so both bylines remain null. The deterministic public fixture verifies author enrichment when declared. Raw native Markdown intentionally still contains its source boilerplate; callers needing normalized article text use `textContent` or `content`. A missing HTML counterpart cannot restore boundaries or metadata erased upstream. There is no JavaScript rendering, full-site crawl or arbitrary-site completeness claim.

A separate existing metadata defect surfaced in the same pass: Daring Fireball's iPhone Duo page returns `Wednesday, 21 October 2026` as its byline in both the preferred and HTML-only readers. It is tracked as 2945; this fix does not alter HTML metadata selection.

Final checks: 63 article tests and 19 source tests passed with zero failures, skips or TODOs. `nx run source-web-articles:typecheck` and all 23 dependent tasks passed, including lint and formatting. Every file changed for 2941 was read in full. Removal audit: the task adds 59 production lines and removes 5, plus 230 regression-test lines; documentation is also updated. This is additive composition, not a claimed code removal. No parsing mechanism was replaced: the existing package-owned selection and raw-source contract were retained. Self-audit found no unused export, configuration/default, compatibility branch or forwarding-only wrapper. The two public call paths use the new composition method. No active-scope decision remains unresolved; general extraction completeness is unproven beyond the stated fixtures and live sample. Temporary probes, response captures and logs are removed after recording this evidence; no benchmark runner is added to the repo.

## Dateline author correction (2945) — 2026-10-24

Live reproduction on [The iPhone Duo](https://daringfireball.net/2026/10/the_iphone_duo) returned `byline: "Wednesday, 21 October 2026"`. The real candidate was `<h6 class="dateline">Wednesday, 21 October 2026</h6>`. Installed Readability 0.6.0 includes `dateline` in `REGEXPS.byline`; `_isValidByline` accepts a class/id match with nonempty text shorter than 100 characters. The public constructor options expose no override for that matcher. This is a metadata false positive, independent of Markdown negotiation and content selection.

The fix normalizes only Readability's DOM input: replace case-insensitive `dateline` substrings with spaces in class/id hints after Defuddle has selected the article. A space prevents joining the surrounding text into a new author hint: a public regression first failed because removing `dateline` from `bydatelineline` created `byline`. Other hints and explicit author metadata remain. It does not parse dates, blacklist names, delete DOM elements, infer a publication date or alter the selected article. The source receives the corrected `byline` through the same public reader, including HTML companions for native Markdown. The change reaches `HTMLExtraction.select`, its public `WebArticle.fetch` regression tests and documentation; no caller, schema, export, dependency or configuration changes are needed.

Package audit: read Readability's public exports/types/options and `_isValidByline`/`_grabArticle` metadata path; no supported matcher option exists. Defuddle's public `author` field found `John Gruber` from the live sidebar's `By ...` text, but a real package probe returned an empty author for the existing `<footer><span rel="author">Lina Haddad</span></footer>` case. REJECTED replacing author extraction wholesale: it loses genuine authors and changes metadata precedence and normalization. REJECTED patching Readability's private matcher or adding a language-dependent date parser. RETAINED the existing extraction packages, declared metadata precedence, footer-author support and raw publication-date contract. The small normalization is not a new metadata parser.

The initial article baseline passed all 63 tests. A public regression then failed with the English date instead of null; a second failed with the French date through an ID after the initial class-only fix. Both passed after the final normalization. Controls verify Arabic text, mixed-case/composite identifiers, dates within article prose, JSON-LD precedence over meta author, nested `rel="author"`, `itemprop="author"`/`name`, `p-author`, composite author classes and the genuine name `May`. Existing tests retain footer authors, short linked posts, tables, sanitization and cancellation. A preliminary assertion expecting a metadata heading to survive was corrected: Defuddle already removes that heading before the metadata change, while dates within prose remain covered.

Fresh before/after live passes covered 17 articles across Anthropic, Simon Willison, Julia Evans, Python Insider, Martin Fowler, GitHub, Cloudflare, JSON Feed and Daring Fireball. The only changed field was the Daring Fireball byline, now null. Every other field of that article and every field of the other 16 articles were deeply equal, including native Markdown bodies and their HTML-companion dates. Simon's short linked post, six tables and 91 cells remained intact. Each pass made 19 article HTTP requests; no additional request was introduced by this fix. These checks used the shared checkout at implementation time, including its concurrent Markdown work. They are sampled public SDK checks, not a full-site crawl.

Removal audit: 2945 adds 10 production lines and 112 public regression-test lines, with no deletions, plus documentation. This is a bounded normalization of dependency input, not a claimed code removal. No new package, parser, abstraction, export, option or compatibility branch was added. Every changed file was read in full. Existing metadata heuristics remain; Daring Fireball's author and publication date are now both unknown rather than inferred from its unstructured text. General author-detection completeness is unproven beyond these fixtures and live pages; no active-scope decision remains unresolved.

Final checks: all 66 article tests and 19 source tests passed with zero failures, skips or TODOs. `nx run source-web-articles:typecheck` and its 23 dependent tasks passed, including lint and formatting. The final built code passed another live comparison against the original before-fix captures for all 17 pages. All owned test/probe processes exited; scripts, captures and logs were removed from temporary scratch after recording this evidence. No benchmark artifact was added to the repository.
