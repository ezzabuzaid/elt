import { readFile } from 'node:fs/promises';
import type { Catalog } from './catalog.ts';
import type { CopyConfiguration } from './copy-configuration.ts';
import type { DocumentParser } from './document-parser.ts';
import type { Stream } from './stream.ts';

export type SourceWatchOptions = {
  readonly streams: readonly Stream[];
  readonly signal: AbortSignal;
};

export type RecordMessage = {
  readonly stream: string;
  readonly data: unknown;
  // Source-owned staging path, valid until the consumer advances the iterator.
  // null means this record has no exportable file (for example a URL attachment).
  readonly file?: string | null;
};

export type StateMessage = {
  readonly type: 'STATE';
  readonly stream: string;
  readonly state: unknown;
};

export type SourceMessage = RecordMessage | StateMessage;

export abstract class Source {
  abstract readonly identity: string;
  abstract discover(): Promise<Catalog>;
  // Check source-owned metadata without extraction or rediscovery.
  abstract validate(configuration: CopyConfiguration): void;
  // Subscribe before yielding all selected streams once, then yield invalidations.
  // Keep receiving changes until signal aborts, including while extraction runs.
  abstract watch(options: SourceWatchOptions): AsyncIterable<readonly Stream[]>;
  // Must be lazy: the destination prepares its target before pulling records.
  async *read(
    configuration: CopyConfiguration,
    state: unknown,
  ): AsyncGenerator<SourceMessage> {
    this.validate(configuration);
    for await (const message of this.extract(configuration, state)) {
      if ('type' in message || configuration.fileReads.length === 0) {
        yield message;
        continue;
      }
      if (message.stream !== configuration.stream.name)
        throw new TypeError(
          `Source emitted an unselected stream: ${message.stream}`,
        );
      if (message.file !== null && typeof message.file !== 'string')
        throw new TypeError(
          'File extraction must supply a staging path or explicit null',
        );
      const data = message.data;
      if (data === null || typeof data !== 'object' || Array.isArray(data))
        throw new TypeError('File metadata must be an object');
      const output = { ...data };
      const values = new Map<
        DocumentParser | undefined,
        Promise<string | Uint8Array>
      >();
      for (const read of configuration.fileReads) {
        if (
          Object.keys(data).some(
            (name) => name.toLowerCase() === read.name.toLowerCase(),
          )
        )
          throw new TypeError('File field collides with source metadata');
        let value: string | Uint8Array | null = null;
        if (message.file !== null) {
          let pending = values.get(read.parser);
          if (pending === undefined) {
            // ponytail: binary fields hold a whole file in memory; use external storage for large files.
            pending =
              read.parser === undefined
                ? readFile(message.file)
                : read.parser.parse(message.file);
            values.set(read.parser, pending);
          }
          value = await pending;
          if (read.parser !== undefined && typeof value !== 'string')
            throw new TypeError('Document parser must return text');
        }
        Object.defineProperty(output, read.name, { value, enumerable: true });
      }
      yield { stream: message.stream, data: output };
    }
  }

  protected abstract extract(
    configuration: CopyConfiguration,
    state: unknown,
  ): AsyncIterable<SourceMessage>;
}
