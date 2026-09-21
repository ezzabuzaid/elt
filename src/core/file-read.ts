import { DocumentParser } from './document-parser.ts';
import type { Stream } from './stream.ts';

// A source resource, not a local path. Only the source can export its contents.
export class FileReference {
  constructor(readonly stream: Stream) {
    Object.freeze(this);
  }
}

// A named extraction request. Destinations choose how to store its result.
export class FileRead {
  readonly parserIdentity?: string;

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
    this.parserIdentity = parser?.identity;
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
    };
  }
}
