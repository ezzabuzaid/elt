import { setTimeout as sleep } from 'node:timers/promises';

import type { StreamCheck, SyncHistory } from '../state/sync-history.ts';
import { Connection } from './connection.ts';
import {
  type Copy,
  type CopyOutcome,
  type CopyResult,
  describeFailures,
} from './copy.ts';
import type { DerivedDataset } from './derived-dataset.ts';
import { DerivedRefreshes } from './derived-refreshes.ts';
import { interleave } from './interleave.ts';
import type { PassObserver } from './pass-observer.ts';
import { replicate } from './replication.ts';
import type { Source } from './source.ts';
import type { Stream } from './stream.ts';
import type { Target as DestinationTarget } from './target.ts';

// How long a stopping watch waits for a source to finish stopping, such as
// ending a helper process, before it leaves the source behind: a source that
// ignores its signal must not hang its host's shutdown, as a grace period
// bounds a process's SIGTERM before SIGKILL.
const stopGraceMs = 1000;

// When a watch loads a stream again, with no change, after its copy failed
// for a system reason, as Airbyte's platform retries a failed sync attempt:
// 10 s after the first failure and three times longer after each further one
// in a row, at most 30 minutes, until 5 in a row failed; the source's next
// change then starts over. Airbyte also stops at 10 failures in all, which
// binds only once attempts that made progress break up a run of failures; a
// watch does not count progress. As in Airbyte, a config failure is never
// retried: only the user can fix it, and the source's next change loads it.
// https://github.com/airbytehq/airbyte-platform/blob/f69abdf9567f1d496fdb7b69e2265e0104c5f2d3/airbyte-workers/src/main/kotlin/io/airbyte/workers/runtime/AirbyteWorkerRetryConfig.kt#L9-L13
// https://github.com/airbytehq/airbyte-platform/blob/f69abdf9567f1d496fdb7b69e2265e0104c5f2d3/airbyte-commons-temporal/src/main/kotlin/io/airbyte/commons/temporal/scheduling/retries/BackoffPolicy.kt#L32-L42
// https://github.com/airbytehq/airbyte-platform/blob/f69abdf9567f1d496fdb7b69e2265e0104c5f2d3/airbyte-commons-temporal/src/main/kotlin/io/airbyte/commons/temporal/scheduling/retries/RetryManager.kt#L94-L98
// https://github.com/airbytehq/airbyte-platform/blob/f69abdf9567f1d496fdb7b69e2265e0104c5f2d3/airbyte-workers/src/main/kotlin/io/airbyte/workers/temporal/scheduling/ConnectionManagerWorkflowImpl.kt#L534
const retryLimit = 5;
const retryDelayMs = (failures: number) =>
  Math.min(10_000 * 3 ** (failures - 1), 30 * 60_000);

// What a source answered, before a pass, about how current a copy's upstream
// is, or why it could not tell.
type Asked<Target extends DestinationTarget> =
  | { readonly copy: Copy<Target>; readonly upstream: Date | null }
  | {
      readonly copy: Copy<Target>;
      readonly unknown: { readonly error: unknown };
    };

// One connection's read over the copies it selected, and what each loaded.
export type Pass<Target extends DestinationTarget> = {
  readonly connection: Connection<Target>;
  readonly outcomes: readonly CopyOutcome<Target>[];
};

// A run that did not load completely, as its sync history recorded. Like
// Airbyte, every copy still ran; results holds each one's committed counts and
// failures, and cause is the first failure.
export class PipelineError<
  Target extends DestinationTarget,
> extends AggregateError {
  override name = 'PipelineError';
  readonly results: readonly CopyOutcome<Target>[];
  constructor(results: readonly CopyOutcome<Target>[]) {
    const incomplete = results.filter(({ failures }) => failures.length > 0);
    const errors = incomplete.flatMap(({ failures }) =>
      failures.map(({ error }) => error),
    );
    super(
      errors,
      `The following copies did not load completely: ${incomplete.map(describeFailures).join('; ')}`,
      { cause: errors[0] },
    );
    this.results = Object.freeze([...results]);
  }
}

// A watch that ended, once every connection stopped or its signal aborted,
// with failed watchers: each error names a connection whose watcher failed,
// and the sync history recorded why.
export class WatchError extends AggregateError {
  override name = 'WatchError';
}

// The orchestrator. Connections are independent: each pass reads one
// connection's source into its destination, and passes of different
// connections run side by side, so a slow source never holds back another.
export class Pipeline<Target extends DestinationTarget> {
  readonly connections: readonly Connection<Target>[];
  readonly history: SyncHistory<Target>;
  readonly observer?: PassObserver<Target>;
  // In declared order, which is the order they refresh in.
  readonly derived: readonly DerivedDataset<Target>[];

  constructor({
    connections,
    history,
    observer,
    derived,
  }: {
    connections: readonly Connection<Target>[];
    history: SyncHistory<NoInfer<Target>>;
    observer?: PassObserver<NoInfer<Target>>;
    // A pipeline that keeps no derived data declares none.
    derived?: readonly DerivedDataset<NoInfer<Target>>[];
  }) {
    if (!connections.every((connection) => connection instanceof Connection))
      throw new TypeError(
        'Pipeline connections must be Connection declarations',
      );
    this.connections = Object.freeze([...connections]);
    this.history = history;
    this.observer = observer;
    this.derived = Object.freeze([...(derived ?? [])]);
    Object.freeze(this);
  }

  // Airbyte's Clear for these copies: empties each target and removes its checkpoint.
  async clear(
    steps: readonly Copy<Target>[] = this.connections.flatMap(
      (connection) => connection.steps,
    ),
  ): Promise<void> {
    this.#assertDistinct();
    for (const connection of this.connections) connection.validate();
    for (const copy of steps) {
      const connection = this.connections.find(({ steps }) =>
        steps.includes(copy),
      );
      if (connection === undefined)
        throw new TypeError("Only this pipeline's copies can be cleared");
      await copy.clear(
        connection.source,
        connection.destination,
        connection.checkpoints,
      );
    }
  }

  // Once signal aborts, each pass stops at its next message and is recorded as
  // cancelled, and the run rejects with the signal's reason, as fetch does. A
  // stop that comes after the passes ended only stops the derived data
  // catching up: the run ends as its passes did, and the next refresh goes on.
  async run(options?: {
    readonly signal?: AbortSignal;
  }): Promise<CopyResult<Target>[]> {
    const signal = options?.signal;
    await this.#declare();
    const passes = await Promise.allSettled(
      this.connections.map((connection) =>
        this.#pass(connection, connection.steps, signal),
      ),
    );
    // A pass rejects only with an error no history recorded, such as the
    // history's own; the run rejects with it once every other pass ended.
    const unrecorded = passes.find(
      (pass): pass is PromiseRejectedResult => pass.status === 'rejected',
    );
    if (unrecorded !== undefined) throw unrecorded.reason;
    const results = passes.flatMap((pass) =>
      pass.status === 'fulfilled' ? pass.value.outcomes : [],
    );
    if (results.some(({ cancelled }) => cancelled)) throw signal?.reason;
    // Derived data follows what the copies committed, also when some copies
    // failed; a dataset's own failure rejects the run as itself, since no
    // history recorded it.
    for (const dataset of this.derived)
      await dataset.refresh({ connections: this.connections, signal });
    if (results.some(({ failures }) => failures.length > 0))
      throw new PipelineError(results);
    return results.map(({ failures: _, cancelled: __, ...result }) => result);
  }

  // Each connection watches its own source and runs a pass for what changed.
  // A connection whose watcher fails stops alone, and its failure is recorded;
  // the rest keep watching. Once every connection stopped, or signal aborts,
  // the recorded failures are thrown together as a WatchError. An error the
  // sync history could not record, or a derived dataset's own failure, stops
  // every connection and rejects as itself.
  async *watch({
    signal,
  }: {
    signal: AbortSignal;
  }): AsyncGenerator<Pass<Target>> {
    await this.#declare();
    if (signal.aborted) return;
    const controller = new AbortController();
    const watching = AbortSignal.any([signal, controller.signal]);
    const stopped: unknown[] = [];
    const refreshes = new DerivedRefreshes(
      this.derived,
      this.connections,
      watching,
      (error) => controller.abort(error),
    );
    const passes = interleave(
      this.connections
        .filter(({ steps }) => steps.length > 0)
        .map((connection) =>
          this.#watch(connection, watching, controller, stopped),
        ),
      Number.POSITIVE_INFINITY,
    );
    // Advanced by hand: yield* would forward a consumer's early return to the
    // merged loops before the abort that lets idle ones finish.
    try {
      for (
        let next = await passes.next();
        !next.done;
        next = await passes.next()
      ) {
        refreshes.request();
        yield next.value;
      }
    } finally {
      controller.abort();
      await passes.return(undefined);
      await refreshes.settled();
    }
    if (refreshes.failure !== undefined) throw refreshes.failure.error;
    if (stopped.length > 0)
      throw new WatchError(stopped, stopped.map(message).join('; '));
  }

  async *#watch(
    connection: Connection<Target>,
    signal: AbortSignal,
    // Stops every connection's watch.
    everyone: AbortController,
    stopped: unknown[],
  ): AsyncGenerator<Pass<Target>> {
    const controller = new AbortController();
    const watching = AbortSignal.any([signal, controller.signal]);
    const streams = new Map(
      connection.steps.map((copy) => [copy.from.name, copy.from]),
    );
    const pending = new Set<string>();
    // A check vouches for a stream only when nothing changed it, no pass is
    // reading it, and its last copy loaded completely: a stream whose change
    // failed to load stays current only as of before that change.
    const loading = new Set<string>();
    const loaded = new Set<string>();
    // Each stream whose copy last failed for a system reason: how many times
    // in a row, and when the watch loads it again.
    const retries = new Map<
      string,
      { readonly failures: number; readonly at: number }
    >();
    let wake = Promise.withResolvers<void>();
    // An abort wakes the loop below, whether or not the source heeds it.
    watching.addEventListener('abort', () => wake.resolve(), { once: true });
    let finished = false;
    // The watcher's own failure, which the history records once it stopped,
    // and a check the history could not record, which stops the whole watch.
    let failure: { readonly error: unknown } | undefined;
    let unrecorded: { readonly error: unknown } | undefined;
    const receive = (async () => {
      let initial = true;
      try {
        for await (const changed of connection.source.watch({
          streams: [...streams.values()],
          signal: watching,
        })) {
          for (const stream of changed) {
            if (!streams.has(stream.name))
              throw new TypeError(
                `Watcher emitted an unselected stream: ${stream.name}`,
              );
            pending.add(stream.name);
          }
          if (initial && pending.size !== streams.size)
            throw new TypeError(
              'Watcher must initially invalidate every selected stream',
            );
          initial = false;
          if (pending.size > 0) wake.resolve();
          const current = [...streams.values()].filter(
            ({ name }) =>
              loaded.has(name) && !pending.has(name) && !loading.has(name),
          );
          if (current.length > 0)
            try {
              await this.history.checked(connection, new Date(), (at) =>
                checked(connection.source, current, at),
              );
            } catch (error) {
              unrecorded = { error };
              return;
            }
        }
        if (initial && !watching.aborted)
          throw new TypeError('Watcher ended before its initial invalidation');
      } catch (error) {
        if (!(
          watching.aborted &&
          error instanceof Error &&
          error.name === 'AbortError'
        ))
          failure = { error };
      } finally {
        finished = true;
        wake.resolve();
      }
    })();
    try {
      while (
        !watching.aborted &&
        failure === undefined &&
        unrecorded === undefined
      ) {
        // Retries end with the watcher, as its changes do.
        if (!finished)
          for (const [name, { at }] of retries)
            if (at <= Date.now()) pending.add(name);
        if (pending.size === 0) {
          if (finished) break;
          const woken = wake;
          const due = Math.min(...[...retries.values()].map(({ at }) => at));
          const retrying = Number.isFinite(due)
            ? setTimeout(() => woken.resolve(), due - Date.now())
            : undefined;
          await woken.promise;
          clearTimeout(retrying);
          continue;
        }
        const steps = connection.steps.filter((copy) =>
          pending.has(copy.from.name),
        );
        pending.clear();
        for (const copy of steps) loading.add(copy.from.name);
        wake = Promise.withResolvers<void>();
        // Like a schedule after a failed sync, watching goes on: each pass
        // reports what did not load, and a retry or the source's next change
        // loads it again. A stopping watch stops the pass it is running, as
        // run({ signal }) does.
        const pass = await this.#pass(connection, steps, signal);
        for (const { copy, failures } of pass.outcomes) {
          const { name } = copy.from;
          loading.delete(name);
          if (failures.length === 0) loaded.add(name);
          else loaded.delete(name);
          // A success, a failure only the user can fix, or the last failure
          // the limit allows ends the run of retries.
          const inARow = (retries.get(name)?.failures ?? 0) + 1;
          if (
            failures.some(({ failureType }) => failureType === 'system') &&
            inARow < retryLimit
          )
            retries.set(name, {
              failures: inARow,
              at: Date.now() + retryDelayMs(inARow),
            });
          else retries.delete(name);
        }
        yield pass;
      }
      if (unrecorded !== undefined) throw unrecorded.error;
      if (failure !== undefined) {
        await this.#recordFailure(connection, failure.error);
        stopped.push(connectionError(connection, failure.error));
      }
    } catch (error) {
      // No history recorded this error, so no reader would see it: every
      // connection stops at once, rather than once each next changes.
      everyone.abort();
      throw error;
    } finally {
      controller.abort();
      const graced = new AbortController();
      await Promise.race([
        receive,
        sleep(stopGraceMs, undefined, {
          ref: false,
          signal: graced.signal,
        }).catch(() => undefined),
      ]);
      graced.abort();
    }
  }

  // One read per pass, never held between watch passes: a long read can
  // block the upstream's own maintenance, such as SQLite WAL checkpoints.
  async #pass(
    connection: Connection<Target>,
    steps: readonly Copy<Target>[],
    signal: AbortSignal | undefined,
  ): Promise<Pass<Target>> {
    const { source } = connection;
    // Asked before the read, so a store an app stopped writing is current
    // only as of then.
    const asked = await Promise.all(
      steps.map(async (copy): Promise<Asked<Target>> => {
        try {
          return { copy, upstream: await source.currentAsOf(copy.from) };
        } catch (error) {
          return { copy, unknown: { error } };
        }
      }),
    );
    const record = await this.history.begin(
      connection,
      steps.map((copy) => ({ copy, coverage: source.coverage(copy.from) })),
    );
    const observed = advise(() => this.observer?.begin(connection));
    const read = await replicate(
      source,
      connection.destination,
      connection.checkpoints,
      asked.flatMap((answer) => ('upstream' in answer ? [answer.copy] : [])),
      observed && ((progress) => advise(() => observed.progress(progress))),
      signal,
    );
    // A copy whose source could not tell how current its upstream is was not
    // read: what it would load could not be dated.
    const outcomes: CopyOutcome<Target>[] = [
      ...read,
      ...asked.flatMap((answer) =>
        'unknown' in answer
          ? [
              {
                copy: answer.copy,
                count: 0,
                deleted: 0,
                failures: [
                  {
                    partition: null,
                    error: answer.unknown.error,
                    failureType: source.failureType(answer.unknown.error),
                  },
                ],
                cancelled: false,
              },
            ]
          : [],
      ),
    ];
    await record.finish(
      outcomes,
      new Map(
        asked.flatMap((answer) =>
          'upstream' in answer && answer.upstream !== null
            ? [[answer.copy.from.name, answer.upstream]]
            : [],
        ),
      ),
    );
    advise(() => observed?.finish(outcomes));
    return Object.freeze({ connection, outcomes: Object.freeze(outcomes) });
  }

  // Records why a connection stopped. When the history cannot, the
  // SuppressedError holds both errors, as a failed dispose does.
  async #recordFailure(
    connection: Connection<Target>,
    failure: unknown,
  ): Promise<void> {
    const failureType = connection.source.failureType(failure);
    try {
      const record = await this.history.begin(
        connection,
        connection.steps.map((copy) => ({
          copy,
          coverage: connection.source.coverage(copy.from),
        })),
      );
      await record.fail(failure, failureType);
    } catch (error) {
      throw new SuppressedError(
        error,
        failure,
        `Connection ${connection.name} stopped (${message(failure)}), and its sync history could not record why: ${message(error)}`,
      );
    }
    advise(() => this.observer?.begin(connection).fail(failure, failureType));
  }

  // Every declaration is checked before any connection reads, so a wiring
  // mistake stops the whole pipeline; the connection it belongs to records it,
  // in a history installed first.
  async #declare(): Promise<void> {
    this.#assertDistinct();
    for (const connection of this.connections)
      this.history.validate(connection);
    await this.history.install(this.connections);
    for (const connection of this.connections)
      try {
        connection.validate();
      } catch (error) {
        await this.#recordFailure(connection, error);
        throw error;
      }
    for (const dataset of this.derived) dataset.validate(this.connections);
  }

  #assertDistinct(): void {
    const names = this.connections.map(({ name }) => name);
    if (new Set(names).size !== names.length)
      throw new TypeError('Pipeline connection names must be distinct');
    const ids = this.connections
      .flatMap(({ steps }) => steps.map(({ id }) => id))
      .filter((id) => id !== undefined);
    if (new Set(ids).size !== ids.length)
      throw new TypeError('Pipeline copy IDs must be distinct');
    const derived = this.derived.map(({ name }) => name);
    if (new Set(derived).size !== derived.length)
      throw new TypeError('Pipeline derived dataset names must be distinct');
  }
}

function connectionError(
  connection: Connection<DestinationTarget>,
  cause: unknown,
): Error {
  return new Error(`Connection ${connection.name}: ${message(cause)}`, {
    cause,
  });
}

// The streams a check found unchanged, each current as of the check or as of
// earlier when its source says its upstream was current only then. A stream
// whose source cannot tell is left out: the check does not vouch for it.
async function checked(
  source: Source,
  streams: readonly Stream[],
  at: Date,
): Promise<StreamCheck[]> {
  const answers = await Promise.allSettled(
    streams.map((stream) => source.currentAsOf(stream)),
  );
  return streams.flatMap((stream, index) => {
    const answer = answers[index];
    if (answer?.status !== 'fulfilled') return [];
    const upstream = answer.value;
    return [
      {
        stream: stream.name,
        at: upstream !== null && upstream < at ? upstream : at,
      },
    ];
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// A pass observer is advisory: what it throws never reaches the pass.
function advise<T>(call: () => T): T | undefined {
  try {
    return call();
  } catch {
    return undefined;
  }
}
