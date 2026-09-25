import type { CheckpointStore } from '../state/checkpoint-store.ts';
import {
  Copy,
  CopyError,
  type CopyOutcome,
  type CopyResult,
  describeFailures,
} from './copy.ts';
import type { Destination } from './destination.ts';
import type { Source } from './source.ts';
import type { Target as DestinationTarget } from './target.ts';
import { TargetOwnedError } from './writer.ts';

// A run that did not load completely. Like Airbyte, every copy still ran;
// results holds each one's committed counts and failures, and cause is the
// first failure.
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

export class Pipeline<Target extends DestinationTarget> {
  readonly source: Source;
  readonly destination: Destination<Target>;
  readonly checkpoints?: CheckpointStore;
  readonly steps: readonly Copy<Target>[];

  constructor({
    source,
    destination,
    steps,
    checkpoints,
  }: {
    source: Source;
    destination: Destination<Target>;
    steps: readonly Copy<NoInfer<Target>>[];
    checkpoints?: CheckpointStore;
  }) {
    if (!steps.every((step) => step instanceof Copy))
      throw new TypeError('Pipeline steps must be Copy declarations');
    this.source = source;
    this.destination = destination;
    this.checkpoints = checkpoints;
    this.steps = Object.freeze([...steps]);
    Object.freeze(this);
  }

  // Airbyte's Clear for these copies: empties each target and removes its checkpoint.
  async clear(steps: readonly Copy<Target>[] = this.steps): Promise<void> {
    this.validate();
    for (const copy of steps) {
      if (!this.steps.includes(copy))
        throw new TypeError("Only this pipeline's copies can be cleared");
      await copy.clear(this.source, this.destination, this.checkpoints);
    }
  }

  async run(): Promise<CopyResult<Target>[]> {
    this.validate();
    return this.runSteps(this.steps);
  }

  async *watch({
    signal,
  }: {
    signal: AbortSignal;
  }): AsyncGenerator<CopyResult<Target>[]> {
    this.validate();
    if (signal.aborted || this.steps.length === 0) return;
    const controller = new AbortController();
    const watching = AbortSignal.any([signal, controller.signal]);
    const streams = new Map(
      this.steps.map((copy) => [copy.from.name, copy.from]),
    );
    const pending = new Set<string>();
    let wake = Promise.withResolvers<void>();
    let finished = false;
    let failed = false;
    let failure: unknown;
    const receive = (async () => {
      let initial = true;
      try {
        for await (const changed of this.source.watch({
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
        if (
          !(
            watching.aborted &&
            error instanceof Error &&
            error.name === 'AbortError'
          )
        ) {
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
        const steps = this.steps.filter((copy) => pending.has(copy.from.name));
        pending.clear();
        wake = Promise.withResolvers<void>();
        yield await this.runSteps(steps);
      }
      if (failed) throw failure;
    } finally {
      controller.abort();
      await receive;
    }
  }

  private validate(): void {
    const ids = this.steps
      .map((copy) => copy.id)
      .filter((id) => id !== undefined);
    if (new Set(ids).size !== ids.length)
      throw new TypeError('Pipeline copy IDs must be distinct');
    for (const copy of this.steps)
      copy.validate(this.source, this.destination, this.checkpoints);
    // Two copies with different writers into one target fail before any copy
    // runs rather than after the first commits.
    const writers = new Map<string, string>();
    for (const copy of this.steps) {
      const location = this.destination.location(copy.to);
      const writer = copy.writer(this.source);
      const owner = writers.get(location);
      if (owner !== undefined && owner !== writer)
        throw new TargetOwnedError(location, owner, writer);
      writers.set(location, writer);
    }
  }

  private async runSteps(
    steps: readonly Copy<Target>[],
  ): Promise<CopyResult<Target>[]> {
    const results: CopyOutcome<Target>[] = [];
    // Opened per run, never held between watch batches: a long read can block
    // the upstream's own maintenance, such as SQLite WAL checkpoints.
    await using session = await this.source.session([
      ...new Set(steps.map((copy) => copy.from)),
    ]);
    for (const copy of steps) {
      try {
        results.push({
          ...(await copy.run(
            this.source,
            this.destination,
            session,
            this.checkpoints,
          )),
          failures: [],
        });
      } catch (error) {
        if (!(error instanceof CopyError)) throw error;
        results.push(error.result);
      }
    }
    if (results.some(({ failures }) => failures.length > 0))
      throw new PipelineError(results);
    return results.map(({ failures: _, ...result }) => result);
  }
}
