export class NotesUnavailableError extends Error {
  override name = 'NotesUnavailableError';

  constructor(path: string, cause: unknown) {
    super(
      `The Notes store at ${path} cannot be read. Allow the process that runs the export Full Disk Access in System Settings > Privacy & Security; macOS attributes a child process to the app or launchd job that started it. Notes.app does not need to be open.`,
      { cause },
    );
  }
}
