export class IndexedDBFormatError extends Error {
  override name = 'IndexedDBFormatError';

  constructor(path: string, problem: string, cause?: unknown) {
    super(`${path} is not a readable Chromium IndexedDB: ${problem}`, {
      cause,
    });
  }
}
