export class ContactsUnavailableError extends Error {
  override name = 'ContactsUnavailableError';

  constructor(path: string, cause: unknown) {
    super(
      `The Contacts store at ${path} cannot be read. Allow the process that runs the export Contacts access or Full Disk Access in System Settings > Privacy & Security; macOS attributes a child process to the app or launchd job that started it. Contacts.app does not need to be open.`,
      { cause },
    );
  }
}

// The store's layout changes between macOS releases; reading one we have not
// verified would silently misplace fields.
export class ContactsSchemaError extends Error {
  override name = 'ContactsSchemaError';

  constructor(path: string, missing: readonly string[]) {
    super(
      `The Contacts store at ${path} has a layout this reader does not read (missing ${missing.join(', ')}).`,
    );
  }
}
