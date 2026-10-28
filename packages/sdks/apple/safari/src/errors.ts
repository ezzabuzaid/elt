export class SafariUnavailableError extends Error {
  override name = 'SafariUnavailableError';

  constructor(path: string, cause: unknown) {
    super(
      `Safari data at ${path} cannot be read. Allow the process that runs the export Full Disk Access in System Settings > Privacy & Security; macOS attributes a child process to the app or launchd job that started it. Safari does not need to be open.`,
      { cause },
    );
  }
}
