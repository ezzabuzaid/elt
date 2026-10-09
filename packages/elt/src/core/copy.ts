import type { CheckpointStore } from '../state/checkpoint-store.ts';
import { CopyConfiguration } from './copy-configuration.ts';
import type { Destination } from './destination.ts';
import { FileTransfer } from './file-transfer.ts';
import type { Source } from './source.ts';
import type { Stream } from './stream.ts';
import { Target as DestinationTarget } from './target.ts';
import type { LoadFailure, WriteCount } from './writer.ts';

// A copy that loaded completely: what the destination committed.
export type CopyResult<Target extends DestinationTarget> = WriteCount & {
  readonly copy: Copy<Target>;
};

// What one copy committed, and what did not load; complete when failures is
// empty. A copy the run's signal stopped is cancelled, as Airbyte cancels a
// sync, and its failures hold the signal's reason.
export type CopyOutcome<Target extends DestinationTarget> =
  CopyResult<Target> & {
    readonly failures: readonly LoadFailure[];
    readonly cancelled: boolean;
  };

// One copy of a running pass so far, counted as Airbyte's sync stats tracker
// counts a stream: what the source emitted and what the destination committed.
// It ends once, complete or incomplete, as Airbyte's stream status does.
export type CopyProgress<Target extends DestinationTarget> = {
  readonly copy: Copy<Target>;
  readonly status: 'running' | 'complete' | 'incomplete';
  readonly emitted: WriteCount;
  readonly committed: WriteCount;
};

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
    const files = new FileTransfer(
      this.configuration.fileReads,
      destination.location(this.to),
      this.writer(source),
    );
    const drop = () =>
      destination.clear(
        this.configuration,
        this.to,
        this.writer(source),
        (values) => files.reconcile(values),
      );
    if (this.id !== undefined && checkpoints !== undefined)
      await checkpoints.clear(this.id, drop);
    else await drop();
  }
}
