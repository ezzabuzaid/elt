export class SafariUnavailableError extends Error {
  override name = 'SafariUnavailableError';

  constructor(path: string, cause: unknown) {
    super(
      `Safari data at ${path} cannot be read. Allow the process that runs the export Full Disk Access in System Settings > Privacy & Security; macOS attributes a child process to the app or launchd job that started it. Safari does not need to be open.`,
      { cause },
    );
  }
}

// Safari changes its stores between releases; reading one we have not
// verified would silently misplace fields.
export class SafariSchemaError extends Error {
  override name = 'SafariSchemaError';

  constructor(path: string, missing: readonly string[]) {
    super(
      `The Safari store at ${path} has a layout this reader does not read (missing ${missing.join(', ')}).`,
    );
  }
}
