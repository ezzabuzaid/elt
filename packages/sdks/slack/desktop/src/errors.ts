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
