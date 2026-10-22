// A source-side Strategy: one staged document becomes one content value.
export abstract class DocumentParser {
  readonly identity: string;

  constructor(identity: string) {
    this.identity = identity;
    if (!identity || identity.includes('\0'))
      throw new TypeError('A parser requires a stable identity');
  }

  // null means the file has no text this parser can represent, such as a
  // photo; the field loads as null. Throw only when reading the file failed.
  abstract parse(path: string, signal?: AbortSignal): Promise<string | null>;

  // A composite parser can identify the selected format independently, so
  // changing an audio model does not invalidate unrelated document text.
  // null means this parser does not handle the file; existing text can stay.
  identityFor(_path: string): Promise<string | null> {
    return Promise.resolve(this.identity);
  }
}
