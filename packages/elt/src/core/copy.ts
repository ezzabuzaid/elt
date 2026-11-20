import type { CheckpointStore } from '../state/checkpoint-store.ts';
import { errorMessage } from '../state/sync-history.ts';
import type { PipelineClock } from './clock.ts';
import type { Connection } from './connection.ts';
import { CopyConfiguration } from './copy-configuration.ts';
import type { Destination } from './destination.ts';
import { FileTransfer } from './file-transfer.ts';
import { RaisedFailure } from './raised-failure.ts';
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

// What did not load, naming each distinct failure message once with every
// copy and partition it failed, in order of first appearance, as a log
// aggregator folds repeated lines: a store that refuses five streams gives
// its remedy once.
export function describeFailures<Target extends DestinationTarget>(
  outcomes: readonly CopyOutcome<Target>[],
): string {
  const failed = new Map<string, string[]>();
  for (const { copy, failures } of outcomes)
    for (const { partition, error } of failures)
      failed
        .getOrInsertComputed(errorMessage(error), () => [])
        .push(
          `${copy.id ?? copy.from.name}${partition === null ? '' : ` ${JSON.stringify(partition)}`}`,
        );
  return `The following copies did not load completely: ${Array.from(
    failed,
    ([message, copies]) => `${copies.join(', ')}: ${message}`,
  ).join('; ')}`;
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
    { name, source, destination, checkpoints }: Connection<Target>,
    clock: PipelineClock,
  ): Promise<void> {
    this.validate(source, destination, checkpoints);
    const writer = this.writer(source);
    const files = new FileTransfer(
      source,
      this.configuration.fileReads,
      destination.location(this.to),
      writer,
    );
    const drop = () =>
      destination.clear(
        this.configuration,
        this.to,
        { writer, clock, connection: name },
        (values) => files.reconcile(values),
      );
    // A clear records no failure, so it throws what a file storage raised as
    // the storage threw it.
    try {
      if (this.id !== undefined && checkpoints !== undefined)
        await checkpoints.clear(this.id, drop);
      else await drop();
    } catch (error) {
      throw error instanceof RaisedFailure ? error.error : error;
    }
  }
}
