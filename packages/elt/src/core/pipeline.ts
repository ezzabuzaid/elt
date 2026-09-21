import type { SQLiteCheckpointStore } from '../state/sqlite-checkpoint-store.ts';
import { Copy } from './copy.ts';
import type { Destination } from './destination.ts';
import type { Source } from './source.ts';
import type { Target as DestinationTarget } from './target.ts';
import { CommittedWriteError } from './writer.ts';

export type CopyResult<Target extends DestinationTarget> = {
  readonly copy: Copy<Target>;
  readonly count: number;
};

export class PipelineError<Target extends DestinationTarget> extends Error {
  override name = 'PipelineError';
  readonly completed: readonly CopyResult<Target>[];
  readonly committedCount: number;
  constructor(
    readonly failedCopy: Copy<Target>,
    completed: readonly CopyResult<Target>[],
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.completed = Object.freeze([...completed]);
    this.committedCount =
      cause instanceof CommittedWriteError ? cause.count : 0;
  }
}

export class Pipeline<Target extends DestinationTarget> {
  readonly source: Source;
  readonly destination: Destination<Target>;
  readonly checkpoints?: SQLiteCheckpointStore;
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
    checkpoints?: SQLiteCheckpointStore;
  }) {
    if (!steps.every((step) => step instanceof Copy))
      throw new TypeError('Pipeline steps must be Copy declarations');
    this.source = source;
    this.destination = destination;
    this.checkpoints = checkpoints;
    this.steps = Object.freeze([...steps]);
    Object.freeze(this);
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
  }

  private async runSteps(
    steps: readonly Copy<Target>[],
  ): Promise<CopyResult<Target>[]> {
    const results: CopyResult<Target>[] = [];
    for (const copy of steps) {
      try {
        const count = await copy.run(
          this.source,
          this.destination,
          this.checkpoints,
        );
        results.push({ copy, count });
      } catch (cause) {
        throw new PipelineError(copy, results, cause);
      }
    }
    return results;
  }
}
