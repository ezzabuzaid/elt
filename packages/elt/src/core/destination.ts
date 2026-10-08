import { isDeepStrictEqual } from 'node:util';

import type { CopyConfiguration } from './copy-configuration.ts';
import type { Target as DestinationTarget } from './target.ts';
import type { FieldValues, Stage, Writer } from './writer.ts';

// Recognized warehouse modes; each destination advertises only its implemented subset.
export type DestinationSyncMode =
  'append' | 'overwrite' | 'append_dedup' | 'overwrite_dedup';

// One run's hold on a destination: the run is its only writer until the load
// is disposed. As in Airbyte, a checkpoint is a commit point, and a stage
// commits only its own stream's operations, so a failed stream never publishes
// rows. prepare refuses a target another writer owns (writer names the copy
// across runs) before anything is read, and publishes nothing: a target
// appears no later than its first commit. A stored target the stream no longer
// fits is evolved to it, keeping its rows, as Airbyte's destinations alter a
// table rather than reload it, unless an overwrite would replace those rows
// anyway, which reloads it (see reloadMode); reloading continues the reload
// the copy's last run left open.
export type Load<Target extends DestinationTarget> = AsyncDisposable & {
  prepare(
    configuration: CopyConfiguration,
    target: Target,
    binding: {
      readonly writer: string;
      readonly reloading: boolean;
    },
  ): Promise<Stage>;
};

export abstract class Destination<Target extends DestinationTarget> {
  abstract readonly supportedDestinationSyncModes: readonly DestinationSyncMode[];

  abstract identity(target: Target): string;

  // The stored object a target names; targets at one location share its writer.
  abstract location(target: Target): string;

  // Validate declarations without storage I/O; destinations check their own targets.
  validate(configuration: CopyConfiguration, target: Target): void {
    this.createWriter(configuration, target);
  }

  protected validateConfiguration(
    configuration: CopyConfiguration,
    target: Target,
  ): void {
    configuration.validateSelection();
    if (!isDeepStrictEqual(configuration.fileReads, target.fileReads))
      throw new TypeError('Copy file reads must match the destination target');
    if (
      !this.supportedDestinationSyncModes.includes(
        configuration.destinationSyncMode,
      )
    )
      throw new TypeError(
        `Destination does not support ${configuration.destinationSyncMode}`,
      );
  }

  // Select and validate a loading strategy without acquiring storage resources.
  abstract createWriter(
    configuration: CopyConfiguration,
    target: Target,
  ): Writer;

  abstract load(): Promise<Load<Target>>;

  async clear(
    configuration: CopyConfiguration,
    target: Target,
    writer: string,
    committed?: (values: FieldValues) => Promise<void>,
  ): Promise<void> {
    await this.createWriter(configuration, target).clear(writer, committed);
  }
}
