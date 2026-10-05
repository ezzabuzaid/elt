export class AccountsUnavailableError extends Error {
  override name = 'AccountsUnavailableError';

  constructor(path: string, cause: unknown) {
    super(
      `The system Accounts store at ${path} cannot be read. Allow the process that runs the export Full Disk Access in System Settings > Privacy & Security.`,
      { cause },
    );
  }
}

// Core Data's layout changes between macOS versions; reading one we have not
// verified would misplace accounts and their settings.
export class AccountsSchemaError extends Error {
  override name = 'AccountsSchemaError';

  constructor(path: string, missing: readonly string[]) {
    super(
      `The system Accounts store at ${path} has a layout this reader does not read (missing ${missing.join(', ')}).`,
    );
  }
}
