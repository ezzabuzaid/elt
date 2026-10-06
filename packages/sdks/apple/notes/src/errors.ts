export class NotesUnavailableError extends Error {
  override name = 'NotesUnavailableError';

  constructor(path: string, cause: unknown) {
    super(
      `The Notes store at ${path} cannot be read. Allow the process that runs the export Full Disk Access in System Settings > Privacy & Security; macOS attributes a child process to the app or launchd job that started it. Notes.app does not need to be open.`,
      { cause },
    );
  }
}

// The store's layout changes between macOS releases; reading one we have not
// verified would silently misplace fields.
export class NotesSchemaError extends Error {
  override name = 'NotesSchemaError';

  constructor(path: string, missing: readonly string[]) {
    super(
      `The Notes store at ${path} has a layout this reader does not read (missing ${missing.join(', ')}).`,
    );
  }
}
