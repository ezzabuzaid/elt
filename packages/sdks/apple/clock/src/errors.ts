export class ClockUnavailableError extends Error {
  override name = 'ClockUnavailableError';
  constructor(path: string, cause: unknown) {
    super(
      `The Clock store at ${path} cannot be read. Open Clock once. If macOS denies access, allow the process running the import Full Disk Access in System Settings > Privacy & Security.`,
      { cause },
    );
  }
}
export class ClockSchemaError extends Error {
  override name = 'ClockSchemaError';
  constructor(path: string, missing: readonly string[]) {
    super(
      `The Clock store at ${path} has an unsupported layout (missing ${missing.join(', ')}).`,
    );
  }
}
