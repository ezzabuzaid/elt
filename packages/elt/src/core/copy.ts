import type { SQLiteCheckpointStore } from '../state/sqlite-checkpoint-store.ts';
import { CopyConfiguration } from './copy-configuration.ts';
import type { Destination } from './destination.ts';
import type { WriterClaim } from './ownership.ts';
import type { Source } from './source.ts';
import type { Stream } from './stream.ts';
import { Target as DestinationTarget } from './target.ts';
import type { WriteCount } from './writer.ts';

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

  // The declared id names the replication; without one, the source and stream
  // do. The claim also says how and which partitions this copy loads.
  claim(source: Source): WriterClaim {
    return {
      writer: JSON.stringify(
        this.id !== undefined
          ? { copy: this.id }
          : { source: source.identity, stream: this.from.name },
      ),
      destinationSyncMode: this.configuration.destinationSyncMode,
      primaryKey: this.configuration.primaryKey ?? null,
      partitions: source.partitionsOf(this.from),
    };
  }

  validate(
    source: Source,
    destination: Destination<Target>,
    checkpoints?: SQLiteCheckpointStore,
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

  async run(
    source: Source,
    destination: Destination<Target>,
    checkpoints?: SQLiteCheckpointStore,
  ): Promise<WriteCount> {
    this.validate(source, destination, checkpoints);
    const write = (state: unknown) =>
      destination.write(
        this.configuration,
        this.to,
        source.read(this.configuration, state),
        this.claim(source),
      );
    if (this.configuration.syncMode === 'incremental') {
      if (this.id === undefined || checkpoints === undefined)
        throw new TypeError(
          'Incremental copies require a stable id and checkpoint store',
        );
      return checkpoints.run(
        this.id,
        {
          source: source.identity,
          target: destination.identity(this.to),
          configuration: this.configuration,
        },
        write,
      );
    }
    const { count, deleted } = await write(null);
    return { count, deleted };
  }
}
