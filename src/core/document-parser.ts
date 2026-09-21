// A source-side Strategy: one staged document becomes one content value.
export abstract class DocumentParser {
  constructor(readonly identity: string) {
    if (!identity || identity.includes('\0'))
      throw new TypeError('A parser requires a stable identity');
  }

  abstract parse(path: string): Promise<string>;
}
