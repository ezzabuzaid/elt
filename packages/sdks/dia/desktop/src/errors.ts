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
