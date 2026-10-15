/**
 * A durable Google OAuth grant as the desktop app stores it in its credential
 * vault: the refresh token and every scope it was granted. Access tokens are
 * not stored; each session mints its own for the scopes it needs. The `kind`
 * string keeps its historical BigQuery-era value.
 */
export interface GoogleOAuthCredential {
  readonly kind: 'GOOGLE_BIGQUERY_OAUTH';
  readonly clientId: string;
  readonly refreshToken: string;
  readonly scope: string;
  readonly googleAccountEmail?: string;
  readonly googleAccountId?: string;
}

/**
 * A grant completed through this app's own consent flow: the identity scopes
 * are always requested, so the account is always known.
 */
export interface GoogleDataGrantCredential extends GoogleOAuthCredential {
  readonly googleAccountId: string;
  readonly googleAccountEmail: string;
}
