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
    const ids = this.steps
      .map((copy) => copy.id)
      .filter((id) => id !== undefined);
    if (new Set(ids).size !== ids.length)
      throw new TypeError('Pipeline copy IDs must be distinct');
    for (const copy of this.steps)
      copy.validate(this.source, this.destination, this.checkpoints);
    const results: CopyResult<Target>[] = [];
    for (const copy of this.steps) {
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
