import { isDeepStrictEqual } from 'node:util';
import type { CopyConfiguration } from './copy-configuration.ts';
import type { Target as DestinationTarget } from './target.ts';
import type { FieldValues, Stage, Writer } from './writer.ts';

// Recognized warehouse modes; each destination advertises only its implemented subset.
export type DestinationSyncMode =
  | 'append'
  | 'overwrite'
  | 'append_dedup'
  | 'overwrite_dedup';

// One run's hold on a destination: one transaction every stream's stage
// shares. As in Airbyte, a checkpoint is a commit point, and a stage commits
// only its own stream's operations, so a failed stream never publishes rows.
// prepare refuses a target another writer owns (writer names the copy across
// runs), or one dropped while its copy resumes from a checkpoint, before
// anything is read.
export type Load<Target extends DestinationTarget> = AsyncDisposable & {
  prepare(
    configuration: CopyConfiguration,
    target: Target,
    binding: { readonly writer: string; readonly resuming: boolean },
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
