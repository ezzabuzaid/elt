export class TeamsUnavailableError extends Error {
  override name = 'TeamsUnavailableError';

  constructor(path: string, cause: unknown) {
    super(
      `The Microsoft Teams app's store at ${path} cannot be read. Open Teams, sign in and let it load your chats. If macOS denies access, allow the process that runs the export Full Disk Access in System Settings > Privacy & Security.`,
      { cause },
    );
  }
}

// Microsoft changes what the Teams client keeps between releases; reading a
// shape we have not verified would misplace messages and their conversations.
export class TeamsFormatError extends Error {
  override name = 'TeamsFormatError';

  constructor(record: string, problem: string, cause?: unknown) {
    super(
      `The Microsoft Teams app's ${record} has a shape this reader does not read: ${problem}.`,
      { cause },
    );
  }
}
