// No archive file at the path: Dia is not installed in this home folder, or
// it has not archived a tab yet.
export class DiaArchiveMissingError extends Error {
  override name = 'DiaArchiveMissingError';

  constructor(path: string, cause: unknown) {
    super(
      `Dia keeps no archived tabs at ${path}. Install Dia and open it once, or check the home folder.`,
      { cause },
    );
  }
}

// The archive file is not in the format this SDK reads, such as after a Dia
// update. The message names the place in the file and what is wrong there,
// never a value, so a title or a URL does not reach a log.
export class DiaArchiveFormatError extends Error {
  override name = 'DiaArchiveFormatError';

  constructor(path: string, at: string, problem: string, cause?: unknown) {
    super(
      `Dia's archive at ${path} is not in a known format: ${at} ${problem}.`,
      {
        cause,
      },
    );
  }
}
