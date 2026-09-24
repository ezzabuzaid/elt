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

export type KeyValue = string | number | boolean;

// Removes the destination row with this primary key. Only streams that declare
// emitsDeletes may send it, and only deduplicating loads can apply it.
export type DeleteMessage = {
  readonly type: 'DELETE';
  readonly stream: string;
  readonly key: Readonly<Record<string, KeyValue>>;
};

export type SourceMessage = RecordMessage | StateMessage | DeleteMessage;

export abstract class Source {
  abstract readonly identity: string;
  // Metadata only. Selections must use these exact Stream objects: a stream's
  // schema shapes the destination, so a matching name is not enough.
  protected abstract readonly catalog: Catalog;

  async discover(): Promise<Catalog> {
    return this.catalog;
  }

  // Check source-owned metadata without extraction or rediscovery.
  validate(configuration: CopyConfiguration): void {
    configuration.validate(this.member(configuration.stream));
    this.validateExtraction(configuration);
  }

  async *watch(options: SourceWatchOptions): AsyncGenerator<readonly Stream[]> {
    for (const stream of options.streams) this.member(stream);
    yield* this.observe(options);
  }

  // Source-specific selection rules, checked without I/O.
  protected validateExtraction(_configuration: CopyConfiguration): void {}

  // Subscribe before yielding all selected streams once, then yield invalidations.
  // Keep receiving changes until signal aborts, including while extraction runs.
  protected abstract observe(
    options: SourceWatchOptions,
  ): AsyncIterable<readonly Stream[]>;

  private member(stream: Stream): Stream {
    if (this.catalog.get(stream.name) !== stream)
      throw new TypeError(
        `Stream ${stream.name} is not from this source's discovered catalog`,
      );
    return stream;
  }

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
