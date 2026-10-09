export class SlackDesktopUnavailableError extends Error {
  override name = 'SlackDesktopUnavailableError';

  constructor(path: string, cause: unknown) {
    super(
      `The Slack app's store at ${path} cannot be read. Install Slack from the Mac App Store and sign in, and allow the process that runs the export Full Disk Access in System Settings > Privacy & Security.`,
      { cause },
    );
  }
}

// Slack changes what its app keeps between releases; reading a shape we have
// not verified would misplace messages and their channels.
export class SlackDesktopFormatError extends Error {
  override name = 'SlackDesktopFormatError';

  constructor(record: string, problem: string, cause?: unknown) {
    super(
      `The Slack app's ${record} has a shape this reader does not read: ${problem}.`,
      { cause },
    );
  }
}
