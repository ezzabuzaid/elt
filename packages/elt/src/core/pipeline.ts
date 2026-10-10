import { setTimeout as sleep } from 'node:timers/promises';

import type { SyncHistory } from '../state/sync-history.ts';
import { Connection } from './connection.ts';
import {
  type Copy,
  type CopyOutcome,
  type CopyResult,
  describeFailures,
} from './copy.ts';
import { interleave } from './interleave.ts';
import { replicate } from './replication.ts';
import type { Target as DestinationTarget } from './target.ts';
import { TargetOwnedError } from './writer.ts';

// How long a stopping watch waits for a source to finish stopping, such as
// ending a helper process, before it leaves the source behind: a source that
// ignores its signal must not hang its host's shutdown, as a grace period
// bounds a process's SIGTERM before SIGKILL.
const stopGraceMs = 1000;

// One connection's read over the copies it selected, and what each loaded.
export type Pass<Target extends DestinationTarget> = {
  readonly connection: Connection<Target>;
  readonly outcomes: readonly CopyOutcome<Target>[];
};

// A run that did not load completely. Like Airbyte, every copy still ran;
// results holds each one's committed counts and failures, errors also the
// passes that could not run, and cause is the first failure.
export class PipelineError<
  Target extends DestinationTarget,
> extends AggregateError {
  override name = 'PipelineError';
  readonly results: readonly CopyOutcome<Target>[];
  constructor(
    results: readonly CopyOutcome<Target>[],
    unrun: readonly unknown[],
  ) {
    const incomplete = results.filter(({ failures }) => failures.length > 0);
    const errors = [
      ...incomplete.flatMap(({ failures }) =>
        failures.map(({ error }) => error),
      ),
      ...unrun,
    ];
    super(
      errors,
      [
        ...(incomplete.length > 0
          ? [
              `The following copies did not load completely: ${incomplete.map(describeFailures).join('; ')}`,
            ]
          : []),
        ...unrun.map(message),
      ].join('; '),
      { cause: errors[0] },
    );
    this.results = Object.freeze([...results]);
  }
}

// The orchestrator. Connections are independent: each pass reads one
// connection's source into its destination, and passes of different
// connections run side by side, so a slow source never holds back another.
export class Pipeline<Target extends DestinationTarget> {
  readonly connections: readonly Connection<Target>[];
  readonly history?: SyncHistory<Target>;

  constructor({
    connections,
    history,
  }: {
    connections: readonly Connection<Target>[];
    history?: SyncHistory<NoInfer<Target>>;
  }) {
    if (!connections.every((connection) => connection instanceof Connection))
      throw new TypeError(
        'Pipeline connections must be Connection declarations',
      );
    this.connections = Object.freeze([...connections]);
    this.history = history;
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
    this.#assertOwners();
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
  // cancelled, and the run rejects with the signal's reason, as fetch does.
  async run(options?: {
    readonly signal?: AbortSignal;
  }): Promise<CopyResult<Target>[]> {
    const signal = options?.signal;
    await this.#declare();
    const passes = await Promise.all(
      this.connections.map((connection) =>
        this.#pass(connection, connection.steps, signal).then(
          ({ outcomes }) => outcomes,
          (error: unknown) => connectionError(connection, error),
        ),
      ),
    );
    const unrun = passes.filter((pass): pass is Error => pass instanceof Error);
    const results = passes
      .filter((pass): pass is CopyOutcome<Target>[] => !(pass instanceof Error))
      .flat();
    if (results.some(({ cancelled }) => cancelled)) throw signal?.reason;
    if (unrun.length > 0 || results.some(({ failures }) => failures.length > 0))
      throw new PipelineError(results, unrun);
    return results.map(({ failures: _, cancelled: __, ...result }) => result);
  }

  // Each connection watches its own source and runs a pass for what changed.
  // A connection whose watcher fails stops alone, and its failure is recorded;
  // the rest keep watching. Once every connection stopped, or signal aborts,
  // the failures are thrown together.
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
    const passes = interleave(
      this.connections
        .filter(({ steps }) => steps.length > 0)
        .map((connection) => this.#watch(connection, watching, stopped)),
      Number.POSITIVE_INFINITY,
    );
    // Advanced by hand: yield* would forward a consumer's early return to the
    // merged loops before the abort that lets idle ones finish.
    try {
      for (
        let next = await passes.next();
        !next.done;
        next = await passes.next()
      )
        yield next.value;
    } finally {
      controller.abort();
      await passes.return(undefined);
    }
    if (stopped.length > 0)
      throw new AggregateError(stopped, stopped.map(message).join('; '));
  }

  async *#watch(
    connection: Connection<Target>,
    signal: AbortSignal,
    stopped: unknown[],
  ): AsyncGenerator<Pass<Target>> {
    const controller = new AbortController();
    const watching = AbortSignal.any([signal, controller.signal]);
    const streams = new Map(
      connection.steps.map((copy) => [copy.from.name, copy.from]),
    );
    const pending = new Set<string>();
    let wake = Promise.withResolvers<void>();
    // An abort wakes the loop below, whether or not the source heeds it.
    watching.addEventListener('abort', () => wake.resolve(), { once: true });
    let finished = false;
    let failed = false;
    let failure: unknown;
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
        }
        if (initial && !watching.aborted)
          throw new TypeError('Watcher ended before its initial invalidation');
      } catch (error) {
        if (!(
          watching.aborted &&
          error instanceof Error &&
          error.name === 'AbortError'
        )) {
          failed = true;
          failure = error;
        }
      } finally {
        finished = true;
        wake.resolve();
      }
    })();
    try {
      while (!watching.aborted) {
        if (failed) throw failure;
        if (pending.size === 0) {
          if (finished) return;
          await wake.promise;
          continue;
        }
        const steps = connection.steps.filter((copy) =>
          pending.has(copy.from.name),
        );
        pending.clear();
        wake = Promise.withResolvers<void>();
        // Like a schedule after a failed sync, watching goes on: each pass
        // reports what did not load, and a later invalidation retries it.
        yield await this.#pass(connection, steps, undefined);
      }
      if (failed) throw failure;
    } catch (error) {
      stopped.push(connectionError(connection, error));
      await this.#recordFailure(connection, error).catch((cause: unknown) =>
        stopped.push(connectionError(connection, cause)),
      );
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
    const record = await this.history?.begin(
      connection,
      steps.map((copy) => ({
        copy,
        coverage: connection.source.coverage(copy.from),
      })),
    );
    let outcomes: CopyOutcome<Target>[];
    try {
      outcomes = await replicate(
        connection.source,
        connection.destination,
        connection.checkpoints,
        steps,
        record?.progress?.bind(record),
        signal,
      );
    } catch (error) {
      await record?.fail(error, connection.source.failureType(error));
      throw error;
    }
    await record?.finish(outcomes);
    return Object.freeze({ connection, outcomes: Object.freeze(outcomes) });
  }

  async #recordFailure(
    connection: Connection<Target>,
    error: unknown,
  ): Promise<void> {
    if (this.history === undefined) return;
    const record = await this.history.begin(
      connection,
      connection.steps.map((copy) => ({
        copy,
        coverage: connection.source.coverage(copy.from),
      })),
    );
    await record.fail(error, connection.source.failureType(error));
  }

  // Every declaration is checked before any connection reads, so a wiring
  // mistake stops the whole pipeline; the connection it belongs to records it.
  async #declare(): Promise<void> {
    this.#assertDistinct();
    for (const connection of this.connections)
      this.history?.validate(connection);
    for (const connection of this.connections)
      try {
        connection.validate();
      } catch (error) {
        await this.#recordFailure(connection, error);
        throw error;
      }
    this.#assertOwners();
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
  }

  // Two copies with different writers into one target fail before any copy
  // runs rather than after the first commits.
  #assertOwners(): void {
    const owners = new Map<string, string>();
    for (const connection of this.connections)
      for (const copy of connection.steps) {
        const location = connection.destination.location(copy.to);
        const writer = copy.writer(connection.source);
        const owner = owners.get(location);
        if (owner !== undefined && owner !== writer)
          throw new TargetOwnedError(location, owner, writer);
        owners.set(location, writer);
      }
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

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
