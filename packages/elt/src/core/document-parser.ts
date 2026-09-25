// A source-side Strategy: one staged document becomes one content value.
export abstract class DocumentParser {
  constructor(readonly identity: string) {
    if (!identity || identity.includes('\0'))
      throw new TypeError('A parser requires a stable identity');
  }

  // null means the file has no text this parser can represent, such as a
  // photo; the field loads as null. Throw only when reading the file failed.
  abstract parse(path: string): Promise<string | null>;
}
