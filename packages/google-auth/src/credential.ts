/**
 * A durable Google OAuth grant as the desktop app stores it in its credential
 * vault. The `kind` string is on disk in every stored grant, so it keeps its
 * historical BigQuery-era value; changing it is a vault migration, not a rename.
 */
export interface GoogleOAuthCredential {
  readonly kind: 'GOOGLE_BIGQUERY_OAUTH';
  readonly clientId: string;
  /**
   * Present only on credentials imported from an external tool (the gcloud
   * credential store). Grants this app obtained itself carry no secret; the
   * app's own installed-client secret is supplied at the point of use.
   */
  readonly clientSecret?: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
  readonly scope: string;
  readonly externallyManaged?: boolean;
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

/**
 * A grant another tool minted and keeps on disk, read from an
 * `authorized_user` file in the gcloud credential store. It carries that
 * tool's client secret and no access token yet: the first refresh mints one
 * and yields a `GoogleOAuthCredential` with `externallyManaged: true`. The
 * file's `universe_domain` is not carried; every grant this app meets is on
 * googleapis.com.
 */
export interface GoogleImportedCredential {
  readonly kind: 'GOOGLE_BIGQUERY_OAUTH';
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly scope: string;
  readonly externallyManaged: true;
}
