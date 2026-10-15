import type { GoogleOAuthCredential } from './credential.ts';

/**
 * Google refused to refresh the grant. `invalid_grant` covers revoked
 * consent, an expired refresh token, and the `invalid_rapt` re-authentication
 * demand some Workspace session policies impose. It is the one refusal the
 * user can act on by connecting again. Every other token-endpoint code
 * (`invalid_request`, `invalid_client`) reports a defect in how this app asks
 * for the token and keeps surfacing as the original error.
 */
export class GoogleGrantRevokedError extends Error {
  override readonly name = 'GoogleGrantRevokedError';
  readonly credential: GoogleOAuthCredential;

  /**
   * True for this error and for the token endpoint's refusal it wraps, which
   * names its OAuth error code in the response body (`{ error:
   * "invalid_grant" }`) for the plain refusal and the re-authentication one
   * alike.
   */
  static matches(error: unknown): boolean {
    if (error instanceof GoogleGrantRevokedError) return true;
    if (!(error instanceof Error)) return false;
    return (
      'response' in error &&
      typeof error.response === 'object' &&
      error.response !== null &&
      'data' in error.response &&
      typeof error.response.data === 'object' &&
      error.response.data !== null &&
      'error' in error.response.data &&
      error.response.data.error === 'invalid_grant'
    );
  }

  constructor(credential: GoogleOAuthCredential) {
    super('Google will no longer refresh this grant.');
    this.credential = credential;
  }
}

/** The store holds nothing under `ref`, or holds something that is not a grant. */
export class GoogleGrantMissingError extends Error {
  override readonly name = 'GoogleGrantMissingError';
  readonly ref: string;

  constructor(ref: string) {
    super(`No Google grant is stored under ${ref}.`);
    this.ref = ref;
  }
}
