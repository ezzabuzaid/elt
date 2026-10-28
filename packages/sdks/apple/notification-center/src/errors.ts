export class NotificationCenterUnavailableError extends Error {
  override name = 'NotificationCenterUnavailableError';

  constructor(path: string, cause: unknown) {
    super(
      `The Notification Center store at ${path} cannot be read. Allow the process that runs the export Full Disk Access in System Settings > Privacy & Security.`,
      { cause },
    );
  }
}
