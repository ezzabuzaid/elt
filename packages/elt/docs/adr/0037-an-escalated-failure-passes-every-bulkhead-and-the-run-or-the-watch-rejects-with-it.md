# An escalated failure passes every bulkhead, and the run or the watch rejects with it

Status: Accepted 2026-11-27 (backlog #6148).

Decision-makers: the zukhruf session that wrote the paper of #6148 decided from the evidence of the leaders; Ezz approved the paper ("Build it", 2026-11-27).

`Pool.run` of `@zukhruf/pool` 0.8.149 and later rejects with `DeprecatedRevisionError` once the store holds a newer revision of the worker kind (pool ADR 0022). The host must then start again on the newer code. Context Compiler's `sync watch` runs under launchd `KeepAlive`, which starts it again when it exits. Its OCR reads (`ImageFormat.text`) and its speech reads (`LocalTranscriptionModel` through the AI SDK) call a pool. elt held the error in five bulkheads, so the watch never exited and every later OCR read failed:

1. `DocumentText.compute` made a failed row of every parse error but a stop. The refresh after each pass tried the row again.
2. `refreshComputed` recorded the dataset `failed` in `derived_status`.
3. `DerivedRefreshes` kept the error as a dataset failure (ADR 0031). `run()` rejected with a `DerivedDatasetError`, and `watch()` gave a `DatasetFailure`, which Context Compiler drops.
4. The stream and partition catches of `Source.read` made a `FAILED` stream status of an error of a file-read parser.
5. The replication recorded that status as a `system` failure of the copy, and a watch loaded the copy again after 10 s.

A bulkhead keeps a failure inside one compartment (ADR 0031). A failure that its host must act on belongs to no compartment.

## Decision

An **escalated failure** is a failure that no bulkhead of the pipeline holds, after Akka's `Escalate`: "the supervisor escalates the failure" to its own supervisor. elt gives it as the class `EscalatedFailure`, an `Error` whose `cause` is the error that the side raised:

```ts
export class EscalatedFailure extends Error {
  override readonly name = 'EscalatedFailure';
  declare readonly cause: unknown;
  constructor(cause: unknown);
}
```

- **The side that raised the error wraps it.** Only the side knows that its error is fatal for the host, as the side names the failure type of its error (ADR 0029). `MacOSDocumentParser.parse` of `@eltjs/source-apple-macos` wraps the `DeprecatedRevisionError` of a pool, for images and for audio. elt core imports nothing of the pool.
- **elt never wraps an escalated failure.** `raisedFrom` gives it as it is, and no `DerivedDatasetError` wraps it. Thus `instanceof` is exact, and no catch walks `cause`.
- **Each bulkhead lets it through.** `DocumentText` makes no row of it. `refreshComputed` records no `failed` status. `DerivedRefreshes` keeps no dataset failure: the refresh stops, it hands the failure to its `escalate` callback, and a copy's request starts no refresh after it. `Source.read` gives no `FAILED` status for it: the read ends, and the read's task group stops its other streams (ADR 0018).
- **An escalated failure in a read cancels the copies of the read.** It aborts the signal of the read, as the first error of Go's `errgroup.WithContext` cancels the context of the group. Each copy that is still open is cancelled with it as the reason, as a stopped run cancels its copies with the reason of its signal. The sync history records the pass `cancelled`, so no copy is `failed`, and no pass stays `running` for the next start of the history to record as failed ("The process running this pass ended before the pass did"). Then the pass rejects with the escalated failure.
- **The run and the watch reject with it as itself.** `run()` rejects with it once every pass ended, and no refresh runs after it. `watch()` aborts every connection first and then rejects with it, before a `WatchError`. The abort comes first because the watch merges the passes and the dataset failures with `interleave`, whose `finally` waits for the pending reads of both loops: a throw from the loop of the dataset failures would wait for the passes without end.

## Considered Options

- **The host gives the pipeline a decider, as Akka's `SupervisorStrategy` and Kafka Streams' exception handlers do.** Every host must wire it, and a host that forgets it gets the bug back with no sign. The decider also takes the decision from the side that raised the error (ADR 0029).
- **A third `FailureType`.** A failure type says whose failure it is to fix (ADR 0012), not how far it reaches. A third value mixes the two.
- **A marker on the error of the pool, in zukhruf or as a symbol.** It is a protocol across two repositories for one consumer, and the pool would carry it only for elt.
- **Walk `cause`, as Go's `errors.Is` does.** It is not needed while elt never wraps an escalated failure.
- **The pass rejects with no record, as with an error that the history could not record.** The pass would stay `running`, and the next start of a sole writer's history records it `failed`. The cancelled pass says what happened.

## Consequences

- A watch of an older host ends at its first OCR or speech read after a newer host started on the store. launchd starts it again on the newer code.
- When the program at the launchd entry is still old, each start ends again at its first OCR read, and launchd throttles the starts. Pool ADR 0022 accepts this.
- A run keeps its passes running after an escalated failure of a refresh, and it rejects once they ended.
- A deprecated `PoolWorkers` whose `ready()` rejects ends no watch by itself.
- Out of elt: Context Compiler's `Connector.#load` must let an `EscalatedFailure` through before it saves a connection failure, so its CLI exits 1 (#6148).

## Confirmation

- Tests, red before the change and green after it: `packages/destinations/sqlite/src/computed-dataset.test.ts` ("under a watch, a file whose parse escalates a failure ends the watch with that failure ...", "a run whose parse of a file escalates a failure rejects with that failure ..."), `packages/destinations/sqlite/src/parsed-file-failures.test.ts` (a file-read parser that escalates, under a watch and in a run), and `packages/sources/apple/macos/src/macos-document-parser.test.ts` (a real `Pool` on a store that holds a newer revision, for an image and for audio through `transcribe` with `maxRetries: 0`). Controls: an ordinary parse error still makes a failed row under a watch, and a failed copy in a run.
- The red run of the audio test got the `DeprecatedRevisionError` itself from `parse`: the AI SDK rethrows the error of the model unchanged when it makes no retries.
- Leaders (from the paper of #6148): controller-runtime requeues a reconcile error (`reconcile.go:117-119`) and ends the manager on a runnable's error (`manager/internal.go:495-497`); Kafka Streams' `ProcessingExceptionHandler` returns `CONTINUE` or `FAIL` (`ProcessingExceptionHandler.java:69-72`); Temporal's TypeScript worker ends on an `UnexpectedError` (`worker/src/worker.ts:1749-1752`); Go's loops check the sentinel `context.Canceled` (`context.go:166-168`). A per-item loop catches only what it owns, and the rest goes up as itself.
