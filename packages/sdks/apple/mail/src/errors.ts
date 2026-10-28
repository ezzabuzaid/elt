export class MailUnavailableError extends Error {
  override name = 'MailUnavailableError';

  constructor(path: string, cause: unknown) {
    super(
      `Mail's store at ${path} cannot be read. Grant the exporting process Full Disk Access in System Settings > Privacy & Security.`,
      { cause },
    );
  }
}

// Mail's store holds something this reader does not know how to read: a
// layout or value Mail has changed.
export class MailSchemaError extends Error {
  override name = 'MailSchemaError';
}

export class MailChangingError extends Error {
  override name = 'MailChangingError';
}
