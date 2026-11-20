import { FileContent } from './file-content.ts';
import type { FileRead } from './file-read.ts';
import { raised, raisedFrom } from './raised-failure.ts';
import type { Source } from './source.ts';
import type { FieldValues } from './writer.ts';

// The shared transfer owns coordination. Stores own bytes; destinations only
// expose the scalar values their rows actually retain after deduplication.
// What a call into a storage throws fails as a RaisedFailure of the storage;
// what a read of the source's file content throws, as one of the source.
export class FileTransfer {
  readonly #source: Source;
  readonly reads: readonly FileRead[];
  readonly location: string;
  readonly writer: string;

  constructor(
    source: Source,
    reads: readonly FileRead[],
    location: string,
    writer: string,
  ) {
    this.#source = source;
    this.reads = reads;
    this.location = location;
    this.writer = writer;
  }

  private scope(read: FileRead): string {
    return JSON.stringify({
      location: this.location,
      writer: this.writer,
      field: read.name,
    });
  }

  async record(record: unknown): Promise<unknown> {
    let data = record;
    for (const read of this.reads) {
      const storage = read.file.storage;
      if (storage === undefined) continue;
      const content: unknown = Reflect.get(Object(data), read.name);
      if (content === null) continue;
      if (!(content instanceof FileContent))
        throw new TypeError('Stored files require source file content');
      const source = this.#source;
      const reference = await raised(storage, () =>
        storage.save(this.scope(read), {
          path: content.path,
          chunks: async function* (size) {
            try {
              yield* content.chunks(size);
            } catch (error) {
              throw raisedFrom(source, error);
            }
          },
        }),
      );
      if (
        typeof reference !== 'string' ||
        !reference ||
        reference.includes('\0') ||
        !reference.isWellFormed()
      )
        throw new TypeError(
          'File storage must return a nonempty text reference',
        );
      data = { ...Object(data), [read.name]: reference };
    }
    return data;
  }

  async flush(): Promise<void> {
    for (const read of this.reads) {
      const storage = read.file.storage;
      if (storage === undefined) continue;
      await raised(storage, () => storage.flush(this.scope(read)));
    }
  }

  async reconcile(values: FieldValues): Promise<void> {
    for (const read of this.reads) {
      const storage = read.file.storage;
      if (storage === undefined) continue;
      const references = new Set<string>();
      for await (const value of values(read.name)) {
        if (value === null) continue;
        if (typeof value !== 'string')
          throw new TypeError('Stored file references must be text or null');
        references.add(value);
      }
      await raised(storage, () => storage.retain(this.scope(read), references));
    }
  }
}
