import { FileContent } from './file-content.ts';
import type { FileRead } from './file-read.ts';
import type { FieldValues } from './writer.ts';

// The shared transfer owns coordination. Stores own bytes; destinations only
// expose the scalar values their rows actually retain after deduplication.
export class FileTransfer {
  readonly reads: readonly FileRead[];
  readonly target: string;
  readonly writer: string;

  constructor(reads: readonly FileRead[], target: string, writer: string) {
    this.reads = reads;
    this.target = target;
    this.writer = writer;
  }

  private scope(read: FileRead): string {
    return JSON.stringify({
      target: this.target,
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
      const reference = await storage.save(this.scope(read), content);
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
      await storage.retain(this.scope(read), references);
    }
  }
}
