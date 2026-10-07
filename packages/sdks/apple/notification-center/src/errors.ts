export class NotificationCenterUnavailableError extends Error {
  override name = 'NotificationCenterUnavailableError';

  constructor(path: string, cause: unknown) {
    super(
      `The Notification Center store at ${path} cannot be read. Allow the process that runs the export Full Disk Access in System Settings > Privacy & Security.`,
      { cause },
    );
  }
}

// usernoted's layout changes between macOS versions; reading one we have not
// verified would misplace notifications and their apps.
export class NotificationCenterSchemaError extends Error {
  override name = 'NotificationCenterSchemaError';

  constructor(path: string, missing: readonly string[]) {
    super(
      `The Notification Center store at ${path} has a layout this reader does not read (missing ${missing.join(', ')}).`,
    );
  }
}
