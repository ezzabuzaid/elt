import { DocumentParser } from './document-parser.ts';
import { FileStorage } from './file-storage.ts';
import type { Stream } from './stream.ts';

// A source resource, not a local path. Only the source can export its contents.
export class FileReference {
  readonly stream: Stream;
  readonly storage?: FileStorage;
  // Only the files this parser accepts, so a remote source downloads no
  // file that a later parse of the stored copy would refuse.
  readonly acceptedBy?: DocumentParser;

  constructor(
    stream: Stream,
    storage?: FileStorage,
    acceptedBy?: DocumentParser,
  ) {
    this.stream = stream;
    this.storage = storage;
    this.acceptedBy = acceptedBy;
    if (acceptedBy !== undefined && !(acceptedBy instanceof DocumentParser))
      throw new TypeError('A file reference accepts files of a DocumentParser');
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
    return new FileReference(this.stream, storage, this.acceptedBy);
  }

  accepting(parser: DocumentParser): FileReference {
    return new FileReference(this.stream, this.storage, parser);
  }
}

// A named extraction request. A stored file becomes a scalar reference before
// its destination receives it; parsing and byte reads remain separate choices.
export class FileRead {
  readonly name: string;
  readonly file: FileReference;
  readonly parser?: DocumentParser;
  readonly parserIdentity?: string;
  readonly storageIdentity?: string;
  readonly acceptingIdentity?: string;

  constructor(name: string, file: FileReference, parser?: DocumentParser) {
    this.name = name;
    this.file = file;
    this.parser = parser;
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
    this.acceptingIdentity = file.acceptedBy?.identity;
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
    if (this.file.acceptedBy?.identity !== this.acceptingIdentity)
      throw new TypeError(
        'Accepting parser identity changed after configuration',
      );
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
      accepting: this.acceptingIdentity,
    };
  }

  // A source that must download a file asks first. A field of bytes or
  // stored files with no accepting parser needs every file.
  accepts(fileName: string): boolean {
    return (
      (this.file.acceptedBy?.accepts(fileName) ?? true) &&
      (this.parser?.accepts(fileName) ?? true)
    );
  }

  get outputType(): 'text' | 'bytes' {
    return this.parser !== undefined || this.file.storage !== undefined
      ? 'text'
      : 'bytes';
  }
}
