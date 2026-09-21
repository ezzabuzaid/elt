import { isDeepStrictEqual } from 'node:util';
import type { CopyConfiguration } from './copy-configuration.ts';
import type { SourceMessage } from './source.ts';
import type { Target as DestinationTarget } from './target.ts';
import type { WriteResult, Writer } from './writer.ts';

// Recognized warehouse modes; each destination advertises only its implemented subset.
export type DestinationSyncMode =
  | 'append'
  | 'overwrite'
  | 'append_dedup'
  | 'overwrite_dedup';

export abstract class Destination<Target extends DestinationTarget> {
  abstract readonly supportedDestinationSyncModes: readonly DestinationSyncMode[];

  abstract identity(target: Target): string;

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

  async write(
    configuration: CopyConfiguration,
    target: Target,
    records: AsyncIterable<SourceMessage>,
  ): Promise<WriteResult> {
    return this.createWriter(configuration, target).write(records);
  }
}
