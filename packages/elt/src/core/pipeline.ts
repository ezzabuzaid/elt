import { type Gauge, delay } from '@zukhruf/async';

import {
  type StreamCheck,
  type SyncHistory,
  errorMessage,
} from '../state/sync-history.ts';
import type { ChangeSignal } from './change-signal.ts';
import type { PipelineClock } from './clock.ts';
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
import {
  PassFailed,
  PassFinished,
  PassStarted,
  passChannels,
} from './pass-channels.ts';
import { replicate } from './replication.ts';
import { brokenSignals, watchSignals } from './signal-watch.ts';
import type { Source } from './source.ts';
import type { Stream } from './stream.ts';
import type { Target as DestinationTarget } from './target.ts';
import type { Upkeep } from './upkeep.ts';

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
// with stopped connections: each error names a connection whose change
// signals broke the contract, and the sync history recorded why.
export class WatchError extends AggregateError {
  override name = 'WatchError';
}

// The orchestrator. Connections are independent: each pass reads one
// connection's source into its destination, and passes of different
// connections run side by side, so a slow source never holds back another.
export class Pipeline<Target extends DestinationTarget> {
  readonly connections: readonly Connection<Target>[];
  readonly history: SyncHistory<Target>;
  // In declared order, which is the order they refresh in.
  readonly derived: readonly DerivedDataset<Target>[];
  readonly #clock: PipelineClock;

  constructor({
    connections,
    history,
    derived,
    clock,
  }: {
    connections: readonly Connection<Target>[];
    history: SyncHistory<NoInfer<Target>>;
    // A pipeline that keeps no derived data declares none.
    derived?: readonly DerivedDataset<NoInfer<Target>>[];
    // Each wait and each read of the time of the pipeline, its sources and
    // its destination (ADR 0019).
    clock: PipelineClock;
  }) {
    if (!connections.every((connection) => connection instanceof Connection))
      throw new TypeError(
        'Pipeline connections must be Connection declarations',
      );
    this.connections = Object.freeze([...connections]);
    this.history = history;
    this.derived = Object.freeze([...(derived ?? [])]);
    this.#clock = clock;
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
      await copy.clear(connection, this.#clock);
    }
  }

  // Once signal aborts, each pass stops at its next message and is recorded as
  // cancelled, and the run rejects with the signal's reason, as fetch does. A
  // stop that comes after the passes ended only stops the derived data
  // catching up: the run ends as its passes did, and the next refresh goes on.
  // While the passes read, each commit asks for a refresh in the background,
  // so derived data follows a long pass. A background refresh's failure
  // stops no pass, and rejects the run once the passes ended, as the failure
  // of a micro-batch fails a Spark query; otherwise the run refreshes once
  // more after the passes, and that refresh's failure rejects it.
  async run(options?: {
    readonly signal?: AbortSignal;
  }): Promise<CopyResult<Target>[]> {
    const signal = options?.signal;
    await this.#declare();
    const refreshes = new DerivedRefreshes(
      this.derived,
      this.connections,
      this.#clock,
      signal,
      () => {},
    );
    let passes: PromiseSettledResult<Pass<Target>>[];
    try {
      passes = await Promise.allSettled(
        this.connections.map((connection) =>
          this.#pass(connection, connection.steps, signal, () =>
            refreshes.request('commit'),
          ),
        ),
      );
    } finally {
      await refreshes.settled();
    }
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
    if (refreshes.failure !== undefined) throw refreshes.failure.error;
    await refreshes.refresh();
    if (results.some(({ failures }) => failures.length > 0))
      throw new PipelineError(results);
    return results.map(({ failures: _, cancelled: __, ...result }) => result);
  }

  // Each connection reads the change signals of its own source and runs a
  // pass for what changed. A failed change signal fails only its streams, and
  // its failure is recorded (ADR 0020); a connection whose change signals
  // break the contract stops alone, and its failure is recorded; the rest keep
  // watching. Once every connection stopped, or signal aborts, the recorded
  // failures are thrown together as a WatchError. An error the sync history
  // could not record, or a derived dataset's own failure, stops every
  // connection and rejects as itself.
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
      this.#clock,
      watching,
      // With no reason: the passes it stops were not refused by this failure,
      // and no sync history records a dataset's failure (ADR 0004).
      () => controller.abort(),
    );
    const passes = interleave(
      this.connections
        .filter(({ steps }) => steps.length > 0)
        .map((connection) =>
          this.#watch(connection, watching, controller, stopped, () =>
            refreshes.request('commit'),
          ),
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
        refreshes.request('pass');
        yield next.value;
      }
    } finally {
      controller.abort();
      await passes.return(undefined);
      await refreshes.settled();
    }
    if (refreshes.failure !== undefined) throw refreshes.failure.error;
    if (stopped.length > 0)
      throw new WatchError(stopped, stopped.map(errorMessage).join('; '));
  }

  async *#watch(
    connection: Connection<Target>,
    signal: AbortSignal,
    // Stops every connection's watch.
    everyone: AbortController,
    stopped: unknown[],
    committed: () => void,
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
    // Change signals that cannot be read as declared, which the history
    // records once the connection stopped, and a check the history could not
    // record, which stops the whole watch.
    let failure: { readonly error: unknown } | undefined;
    let unrecorded: { readonly error: unknown } | undefined;
    // Change signals that break the contract stop their connection: watching
    // them again would only break it again.
    const broken = (message: string) => {
      failure = { error: new TypeError(message) };
    };
    // Each stream whose change signal failed, from the check that saw it fail
    // until a check reads it again: the history records it one time.
    const failing = new Set<string>();
    // When a check last found each stream unchanged, so each check that the
    // history records vouches for each stream as of its own last check.
    const unchangedAt = new Map<string, Date>();
    // Each stream that a check has told about. As an informer lists before it
    // watches, the first pass waits until every stream had its first check:
    // the first pass reads all streams as one task group, and the first value
    // of each gauge is the baseline for the next checks (ADR 0020).
    const told = new Set<string>();
    // Runs an upkeep when the watch starts and then each interval until the
    // watch stops. A failure is recorded one time for each run of failures, as
    // a failed pass of the streams that the watch keeps; after a config
    // failure the upkeep runs no more in this watch, as a gauge does (ADR 0021).
    const keep = async ({ interval, run }: Upkeep) => {
      for (let failed = false; !watching.aborted;) {
        try {
          await run(watching);
          failed = false;
        } catch (error) {
          if (watching.aborted) return;
          if (!failed) {
            try {
              await this.#recordFailure(connection, error, [...streams.keys()]);
            } catch (suppressed) {
              unrecorded = { error: suppressed };
              wake.resolve();
              return;
            }
          }
          failed = true;
          if (connection.source.failureType(error) === 'config') return;
        }
        await delay(interval, { clock: this.#clock, signal: watching }).catch(
          () => undefined,
        );
      }
    };
    // The pipeline reads the source's change signals and decides what each
    // outcome means (ADR 0020).
    const receive = (async () => {
      const keeping: Promise<void>[] = [];
      try {
        // A gauge is the pipeline's from the moment the source gives it, so a
        // source that fails partway through its signals leaves none open. A
        // gauge that stops a helper process can take a moment to stop: the
        // watch waits for it, within the grace of a stopping watch.
        await using gauges = new AsyncDisposableStack();
        const owned = new Set<Gauge>();
        const signals: ChangeSignal[] = [];
        try {
          for (const signal of connection.source.changeSignals(
            [...streams.values()],
            this.#clock,
          )) {
            signals.push(signal);
            if (owned.has(signal.gauge)) continue;
            owned.add(signal.gauge);
            if (isDisposable(signal.gauge)) gauges.use(signal.gauge);
          }
        } catch (error) {
          failure = { error };
          return;
        }
        const contract = brokenSignals(signals, [...streams.values()]);
        if (contract !== undefined) {
          broken(contract);
          return;
        }
        keeping.push(...[...connection.source.upkeep(this.#clock)].map(keep));
        try {
          for await (const outcomes of watchSignals(signals, {
            signal: watching,
            clock: this.#clock,
            failureType: (error) => connection.source.failureType(error),
          })) {
            const at = this.#now();
            for (const [name, outcome] of outcomes) {
              told.add(name);
              if (outcome.state === 'failed') {
                unchangedAt.delete(name);
                if (failing.has(name)) continue;
                failing.add(name);
                try {
                  await this.#recordFailure(connection, outcome.error, [name]);
                } catch (error) {
                  unrecorded = { error };
                  return;
                }
                continue;
              }
              failing.delete(name);
              if (outcome.state === 'changed') {
                unchangedAt.delete(name);
                pending.add(name);
              } else unchangedAt.set(name, at);
            }
            if (pending.size > 0 && told.size === streams.size) wake.resolve();
            const current = [...streams.values()].flatMap((stream) => {
              const checkedAt = unchangedAt.get(stream.name);
              return checkedAt !== undefined &&
                loaded.has(stream.name) &&
                !pending.has(stream.name) &&
                !loading.has(stream.name)
                ? [{ stream, at: checkedAt }]
                : [];
            });
            if (current.length > 0)
              try {
                await this.history.checked(connection, at, () =>
                  checked(connection.source, current),
                );
              } catch (error) {
                unrecorded = { error };
                return;
              }
          }
        } catch (error) {
          // A change watcher refuses an interval or a timeout that is not a
          // positive number of milliseconds: a declaration that breaks the
          // contract.
          if (!watching.aborted) failure = { error };
        }
      } finally {
        // The checks ended, so the connection stops watching: its upkeeps
        // stop too, after its gauges were disposed, so an upkeep that is slow
        // to stop keeps no gauge open.
        controller.abort();
        await Promise.all(keeping);
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
        // Retries end with the change signals, as their changes do.
        if (!finished)
          for (const [name, { at }] of retries)
            if (at <= this.#clock.Date.now()) pending.add(name);
        if (pending.size === 0) {
          if (finished) break;
          // Each wait has its own wake. Each thing that wakes the loop also
          // shows in the checks above, so a wake from before this wait has
          // nothing to tell, and a retry timer that ends before the Date of
          // its retry makes the loop wait again, not spin.
          const woken = (wake = Promise.withResolvers<void>());
          const due = Math.min(...[...retries.values()].map(({ at }) => at));
          const retrying = Number.isFinite(due)
            ? this.#clock.setTimeout(
                () => woken.resolve(),
                due - this.#clock.Date.now(),
              )
            : undefined;
          await woken.promise;
          if (retrying !== undefined) this.#clock.clearTimeout(retrying);
          continue;
        }
        const steps = connection.steps.filter((copy) =>
          pending.has(copy.from.name),
        );
        pending.clear();
        for (const copy of steps) loading.add(copy.from.name);
        // Like a schedule after a failed sync, watching goes on: each pass
        // reports what did not load, and a retry or the source's next change
        // loads it again. A stopping watch stops the pass it is running, as
        // run({ signal }) does.
        const pass = await this.#pass(connection, steps, signal, committed);
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
              at: this.#clock.Date.now() + retryDelayMs(inARow),
            });
          else retries.delete(name);
        }
        yield pass;
      }
      if (unrecorded !== undefined) throw unrecorded.error;
      if (failure !== undefined) {
        await this.#recordFailure(connection, failure.error, [
          ...streams.keys(),
        ]);
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
        delay(stopGraceMs, {
          clock: this.#clock,
          signal: graced.signal,
          ref: false,
        }).catch(() => undefined),
      ]);
      graced.abort();
    }
  }

  // One read per pass, never held between watch passes: a long read can
  // block the upstream's own maintenance, such as SQLite WAL checkpoints.
  // committed is told each time a copy of the pass made rows visible.
  async #pass(
    connection: Connection<Target>,
    steps: readonly Copy<Target>[],
    signal: AbortSignal | undefined,
    committed: () => void,
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
      this.#now(),
    );
    // The pass runs in the stores that subscribers bind to its start, so a
    // subscriber's async context follows the pass's work, as a span's
    // context follows it (Node diagnostics_channel, Channel.runStores).
    return passChannels.start.runStores(
      new PassStarted(connection),
      async () => {
        const read = await replicate(
          source,
          connection.destination,
          connection.checkpoints,
          asked.flatMap((answer) =>
            'upstream' in answer ? [answer.copy] : [],
          ),
          connection,
          committed,
          signal,
          this.#clock,
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
          this.#now(),
        );
        passChannels.finish.publish(new PassFinished(connection, outcomes));
        return Object.freeze({ connection, outcomes: Object.freeze(outcomes) });
      },
    );
  }

  // Records a failure as a failed attempt of the streams that it stopped: why
  // a connection stopped, or why the change signal of one stream failed. When
  // the history cannot, the SuppressedError holds both errors, as a failed
  // dispose does.
  async #recordFailure(
    connection: Connection<Target>,
    failure: unknown,
    stopped: readonly string[],
  ): Promise<void> {
    const failureType = connection.source.failureType(failure);
    // The attempt declares each stream once, as one read covers it once: a
    // connection that copies a stream twice fails its validation for that,
    // and the history still records why.
    const streams = connection.steps.filter(
      (copy, index, steps) =>
        stopped.includes(copy.from.name) &&
        steps.findIndex(({ from }) => from.name === copy.from.name) === index,
    );
    try {
      const record = await this.history.begin(
        connection,
        streams.map((copy) => ({
          copy,
          coverage: connection.source.coverage(copy.from),
        })),
        this.#now(),
      );
      await record.fail(failure, failureType, this.#now());
    } catch (error) {
      throw new SuppressedError(
        error,
        failure,
        `Connection ${connection.name} stopped (${errorMessage(failure)}), and its sync history could not record why: ${errorMessage(error)}`,
      );
    }
    passChannels.failure.publish(
      new PassFailed(connection, failure, failureType),
    );
  }

  // Every declaration is checked before any connection reads, so a wiring
  // mistake stops the whole pipeline; the connection it belongs to records it,
  // in a history installed first.
  async #declare(): Promise<void> {
    this.#assertDistinct();
    for (const connection of this.connections)
      this.history.validate(connection);
    await this.history.install(this.connections, this.#now());
    for (const connection of this.connections)
      try {
        connection.validate();
      } catch (error) {
        await this.#recordFailure(
          connection,
          error,
          connection.steps.map(({ from }) => from.name),
        );
        throw error;
      }
    for (const dataset of this.derived) dataset.validate(this.connections);
  }

  // The time of an event the history records, on the pipeline's clock.
  #now(): Date {
    return new Date(this.#clock.Date.now());
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
  return new Error(`Connection ${connection.name}: ${errorMessage(cause)}`, {
    cause,
  });
}

// The streams that checks found unchanged, each current as of its check or as
// of earlier when its source says its upstream was current only then. A
// stream whose source cannot tell is left out: the check does not vouch for
// it.
async function checked(
  source: Source,
  checks: readonly { readonly stream: Stream; readonly at: Date }[],
): Promise<StreamCheck[]> {
  const answers = await Promise.allSettled(
    checks.map(({ stream }) => source.currentAsOf(stream)),
  );
  return checks.flatMap(({ stream, at }, index) => {
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

function isDisposable(value: object): value is Disposable | AsyncDisposable {
  return Symbol.dispose in value || Symbol.asyncDispose in value;
}
