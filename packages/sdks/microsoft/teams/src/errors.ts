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
