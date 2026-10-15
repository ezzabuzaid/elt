/**
 * The Google account has no Google Health profile, so the API has nothing to
 * read (`400 ACCOUNT_NOT_LINKED`, "The Google account is not linked to a
 * Fitbit account."). Only the user can fix it.
 */
export class GoogleHealthAccountNotLinkedError extends Error {
  override readonly name = 'GoogleHealthAccountNotLinkedError';

  constructor(options: { cause: unknown }) {
    super(
      'This Google account has no Google Health profile. Sign in to the Google Health app on a phone with this account, then try again.',
      options,
    );
  }
}

/**
 * Google Health kept refusing for quota after every retry. Surfaced as its own
 * type so a run fails instead of loading a silently truncated history.
 */
export class GoogleHealthRateLimitError extends Error {
  override readonly name = 'GoogleHealthRateLimitError';
  readonly attempts: number;

  constructor(attempts: number, message: string, options: { cause: unknown }) {
    super(message, options);
    this.attempts = attempts;
  }
}
