export class LevelDBFormatError extends Error {
  override name = 'LevelDBFormatError';

  constructor(path: string, problem: string) {
    super(`${path} is not a readable LevelDB file: ${problem}`);
  }
}
