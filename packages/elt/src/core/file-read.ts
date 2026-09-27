import { DocumentParser } from './document-parser.ts';
import { FileStorage } from './file-storage.ts';
import type { Stream } from './stream.ts';

// A source resource, not a local path. Only the source can export its contents.
export class FileReference {
  constructor(
    readonly stream: Stream,
    readonly storage?: FileStorage,
  ) {
    if (
      storage !== undefined &&
      (!(storage instanceof FileStorage) ||
        typeof storage.identity !== 'string' ||
        storage.identity.length === 0 ||
        !storage.identity.isWellFormed() ||
        storage.identity.includes('\0'))
    )
      throw new TypeError('File storage requires a stable text identity');
    Object.freeze(this);
  }

  store(storage: FileStorage): FileReference {
    return new FileReference(this.stream, storage);
  }
}

// A named extraction request. A stored file becomes a scalar reference before
// its destination receives it; parsing and byte reads remain separate choices.
export class FileRead {
  readonly parserIdentity?: string;
  readonly storageIdentity?: string;

  constructor(
    readonly name: string,
    readonly file: FileReference,
    readonly parser?: DocumentParser,
  ) {
    if (!name || name.includes('\0'))
      throw new TypeError('Invalid file field name');
    if (!(file instanceof FileReference))
      throw new TypeError('File extraction requires a source file reference');
    if (parser !== undefined && !(parser instanceof DocumentParser))
      throw new TypeError('parser must be a DocumentParser');
    if (parser !== undefined && file.storage !== undefined)
      throw new TypeError('Select parsing and storage as separate file fields');
    this.parserIdentity = parser?.identity;
    this.storageIdentity = file.storage?.identity;
    Object.freeze(this);
  }

  validate(stream: Stream): void {
    if (this.file.stream.name !== stream.name)
      throw new TypeError('File reference belongs to another stream');
    if (
      this.file.stream.supportsFileTransfer !== true ||
      stream.supportsFileTransfer !== true
    )
      throw new TypeError(
        `Stream ${stream.name} does not support file extraction`,
      );
    if (this.parser?.identity !== this.parserIdentity)
      throw new TypeError('Parser identity changed after configuration');
    if (this.file.storage?.identity !== this.storageIdentity)
      throw new TypeError('File storage identity changed after configuration');
    const { properties } = stream.jsonSchema;
    if (
      stream.jsonSchema.type !== 'object' ||
      properties === null ||
      typeof properties !== 'object' ||
      Array.isArray(properties)
    )
      throw new TypeError('File extraction requires an object metadata schema');
    if (
      Object.keys(properties).some(
        (name) => name.toLowerCase() === this.name.toLowerCase(),
      )
    )
      throw new TypeError('File field collides with source metadata');
  }

  toJSON(): object {
    return {
      name: this.name,
      stream: this.file.stream.name,
      parser: this.parserIdentity,
      storage: this.storageIdentity,
    };
  }

  get outputType(): 'text' | 'bytes' {
    return this.parser !== undefined || this.file.storage !== undefined
      ? 'text'
      : 'bytes';
  }
}
