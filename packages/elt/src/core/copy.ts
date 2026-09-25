import type { CheckpointStore } from '../state/checkpoint-store.ts';
import { CopyConfiguration } from './copy-configuration.ts';
import type { Destination } from './destination.ts';
import type { Source } from './source.ts';
import type { Stream } from './stream.ts';
import { Target as DestinationTarget } from './target.ts';
import type { LoadFailure, WriteCount, WriteResult } from './writer.ts';

// A copy that loaded completely: what the destination committed.
export type CopyResult<Target extends DestinationTarget> = WriteCount & {
  readonly copy: Copy<Target>;
};

// What one copy committed, and what did not load; complete when failures is empty.
export type CopyOutcome<Target extends DestinationTarget> =
  CopyResult<Target> & {
    readonly failures: readonly LoadFailure[];
  };

// Names every partition, or the whole copy, that did not load.
export class CopyError<
  Target extends DestinationTarget,
> extends AggregateError {
  override name = 'CopyError';
  constructor(readonly result: CopyOutcome<Target>) {
    super(
      result.failures.map(({ error }) => error),
      `Copy did not load completely: ${describeFailures(result)}`,
      { cause: result.failures[0]?.error },
    );
  }
}

export function describeFailures<Target extends DestinationTarget>({
  copy,
  failures,
}: CopyOutcome<Target>): string {
  return failures
    .map(
      ({ partition, error }: LoadFailure) =>
        `${copy.id ?? copy.from.name}${partition === null ? '' : ` ${JSON.stringify(partition)}`}: ${error instanceof Error ? error.message : String(error)}`,
    )
    .join('; ');
}

// One configured transfer from a source stream to a destination declaration.
export class Copy<Target extends DestinationTarget> {
  readonly configuration: CopyConfiguration;
  readonly to: Target;
  readonly id?: string;

  constructor(
    from: Stream,
    to: Target,
    modes: ConstructorParameters<typeof CopyConfiguration>[1] & {
      id?: string;
    } = {
      syncMode: 'full_refresh',
      destinationSyncMode: 'overwrite',
    },
  ) {
    if (!(to instanceof DestinationTarget))
      throw new TypeError('Copy requires a destination target');
    this.configuration = new CopyConfiguration(from, modes, to.fileReads);
    this.to = to;
    if (modes.id !== undefined && (!modes.id || modes.id.includes('\0')))
      throw new TypeError('Copy id must be nonempty text');
    this.id = modes.id;
    Object.freeze(this);
  }

  get from(): Stream {
    return this.configuration.stream;
  }

  // The target's writer: the declared id names the replication; without one,
  // the source and stream do.
  writer(source: Source): string {
    return JSON.stringify(
      this.id !== undefined
        ? { copy: this.id }
        : { source: source.identity, stream: this.from.name },
    );
  }

  validate(
    source: Source,
    destination: Destination<Target>,
    checkpoints?: CheckpointStore,
  ): void {
    source.validate(this.configuration);
    destination.validate(this.configuration, this.to);
    if (
      this.configuration.syncMode === 'incremental' &&
      (this.id === undefined || checkpoints === undefined)
    )
      throw new TypeError(
        'Incremental copies require a stable id and checkpoint store',
      );
  }

  // Empties the target and removes this copy's checkpoint together, so the
  // next run reloads from scratch.
  async clear(
    source: Source,
    destination: Destination<Target>,
    checkpoints?: CheckpointStore,
  ): Promise<void> {
    this.validate(source, destination, checkpoints);
    const drop = () =>
      destination.clear(this.configuration, this.to, this.writer(source));
    if (this.id !== undefined && checkpoints !== undefined)
      await checkpoints.clear(this.id, drop);
    else await drop();
  }

  // Airbyte's replication worker: reads from the source, has the destination
  // commit at each checkpoint, and saves each checkpoint it acknowledged.
  async run(
    source: Source,
    destination: Destination<Target>,
    session: AsyncDisposable,
    checkpoints?: CheckpointStore,
  ): Promise<CopyResult<Target>> {
    this.validate(source, destination, checkpoints);
    const writer = this.writer(source);
    const load = (
      state: unknown,
      acknowledge: (state: unknown) => Promise<void>,
    ) =>
      destination.write(
        this.configuration,
        this.to,
        source.read(this.configuration, state, session),
        { writer, resuming: state !== null, acknowledge },
      );
    let written: WriteResult;
    try {
      if (this.configuration.syncMode === 'incremental') {
        if (this.id === undefined || checkpoints === undefined)
          throw new TypeError(
            'Incremental copies require a stable id and checkpoint store',
          );
        written = await checkpoints.run(
          this.id,
          {
            source: source.identity,
            target: destination.identity(this.to),
            configuration: this.configuration,
          },
          load,
        );
      } else written = await load(null, async () => {});
    } catch (error) {
      written = {
        count: 0,
        deleted: 0,
        failures: [{ partition: null, error }],
      };
    }
    const { failures, ...committed } = written;
    if (failures.length > 0)
      throw new CopyError({ copy: this, ...committed, failures });
    return { copy: this, ...committed };
  }
}
