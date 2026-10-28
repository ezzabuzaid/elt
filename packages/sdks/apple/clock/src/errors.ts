export class ClockUnavailableError extends Error {
  override name = 'ClockUnavailableError';
  constructor(path: string, cause: unknown) {
    super(
      `The Clock store at ${path} cannot be read. Open Clock once. If macOS denies access, allow the process running the import Full Disk Access in System Settings > Privacy & Security.`,
      { cause },
    );
  }
}
