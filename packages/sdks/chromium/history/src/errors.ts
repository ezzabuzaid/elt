// A profile's History that this process cannot open: it is missing, or the
// system denies it.
export class ChromiumHistoryUnavailableError extends Error {
  readonly path: string;

  constructor(path: string, cause: unknown) {
    super(
      `The history at ${JSON.stringify(path)} cannot be read: the file is missing, or this process has no access to it.`,
      { cause },
    );
    this.name = 'ChromiumHistoryUnavailableError';
    this.path = path;
  }
}
