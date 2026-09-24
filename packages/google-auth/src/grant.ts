import type { Credentials } from 'google-auth-library';

import type {
  GoogleDataGrantCredential,
  GoogleImportedCredential,
  GoogleOAuthCredential,
} from './credential.ts';

/**
 * What `GoogleOAuthApp.client` needs from a grant of any shape. Each shape
 * answers for itself, so the app never reads a credential's fields to decide.
 */
export interface GoogleOpenableGrant {
  readonly credential: GoogleOAuthCredential | GoogleImportedCredential;
  /**
   * The library's starting credentials. A shape without an access token makes
   * the client refresh on its first call.
   */
  seed(): Credentials;
  /** The client secret that refreshes this grant, given the app's own. */
  secretOr(appSecret: string): string;
  /**
   * This grant as a vault can hold it, or undefined until Google has minted
   * its first access token.
   */
  durable(): GoogleGrant | undefined;
}

/** A stored grant, read-only, with the questions hosts ask of it. */
export class GoogleGrant implements GoogleOpenableGrant {
  readonly #credential: GoogleOAuthCredential;
  readonly #scopes: ReadonlySet<string>;

  // The store holds other secrets too; a grant this package wrote says so in
  // its kind. Anything else, or nothing, is no grant.
  static parse(value: unknown): GoogleGrant | undefined {
    const credential = value as GoogleOAuthCredential | undefined;
    return credential?.kind === 'GOOGLE_BIGQUERY_OAUTH'
      ? new GoogleGrant(credential)
      : undefined;
  }

  constructor(credential: GoogleOAuthCredential) {
    this.#credential = credential;
    this.#scopes = new Set(credential.scope.split(/\s+/).filter(Boolean));
  }

  get credential(): GoogleOAuthCredential {
    return this.#credential;
  }

  get scopes(): ReadonlySet<string> {
    return this.#scopes;
  }

  covers(scopes: readonly string[]): boolean {
    return scopes.every((scope) => this.#scopes.has(scope));
  }

  get account(): { readonly email: string; readonly id: string } | undefined {
    const { googleAccountEmail: email, googleAccountId: id } = this.#credential;
    return email && id ? { email, id } : undefined;
  }

  seed(): Credentials {
    const { accessToken, expiresAt, refreshToken, scope } = this.#credential;
    return {
      access_token: accessToken,
      expiry_date: expiresAt,
      refresh_token: refreshToken,
      scope,
      token_type: 'Bearer',
    };
  }

  secretOr(appSecret: string): string {
    // A grant the finder imported and the broker stored keeps the secret of
    // the tool that minted it; a grant this app obtained carries none.
    return this.#credential.clientSecret ?? appSecret;
  }

  durable(): GoogleGrant {
    return this;
  }

  /**
   * An imported grant belongs to the tool that minted it; revoking it here
   * would log the user out of that tool.
   */
  get revocable(): boolean {
    return !this.#credential.externallyManaged;
  }
}

/**
 * A grant that knows which Google account it belongs to. Every grant
 * completed through this app's own consent flow is one, because the identity
 * scopes are always requested; a grant imported from another tool is not.
 */
export class GoogleAccountGrant extends GoogleGrant {
  readonly #credential: GoogleDataGrantCredential;

  static override parse(value: unknown): GoogleAccountGrant | undefined {
    const credential = GoogleGrant.parse(value)?.credential;
    return credential && GoogleAccountGrant.#hasAccount(credential)
      ? new GoogleAccountGrant(credential)
      : undefined;
  }

  static #hasAccount(
    credential: GoogleOAuthCredential,
  ): credential is GoogleDataGrantCredential {
    return (
      credential.googleAccountId !== undefined &&
      credential.googleAccountEmail !== undefined
    );
  }

  constructor(credential: GoogleDataGrantCredential) {
    super(credential);
    this.#credential = credential;
  }

  override get credential(): GoogleDataGrantCredential {
    return this.#credential;
  }

  override get account(): { readonly email: string; readonly id: string } {
    const { googleAccountEmail: email, googleAccountId: id } = this.#credential;
    return { email, id };
  }
}

// gcloud's `authorized_user` file, as it writes one.
type AuthorizedUserFile = {
  readonly type?: string;
  readonly client_id?: string;
  readonly client_secret?: string;
  readonly refresh_token?: string;
  readonly account?: string;
};

/**
 * A grant read from another tool's `authorized_user` file. gcloud writes
 * `application_default_credentials.json` without an `account` field and
 * `legacy_credentials/<account>/adc.json` with or without one, so the caller
 * supplies the account the file's location implies. Neither file names a
 * scope, so the caller states the scope it will use the grant for.
 */
export class GoogleImportedGrant implements GoogleOpenableGrant {
  readonly account: string;
  readonly credential: GoogleImportedCredential;

  static parse(
    value: unknown,
    options: { readonly account: string; readonly scope: string },
  ): GoogleImportedGrant | undefined {
    const file = value as AuthorizedUserFile | undefined;
    // Another tool's file: only an authorized user grant can be opened here.
    if (file?.type !== 'authorized_user') return undefined;
    const clientId = file.client_id?.trim();
    const clientSecret = file.client_secret?.trim();
    const refreshToken = file.refresh_token?.trim();
    if (!clientId || !clientSecret || !refreshToken) return undefined;
    return new GoogleImportedGrant(file.account?.trim() || options.account, {
      clientId,
      clientSecret,
      externallyManaged: true,
      kind: 'GOOGLE_BIGQUERY_OAUTH',
      refreshToken,
      scope: options.scope,
    });
  }

  constructor(account: string, credential: GoogleImportedCredential) {
    this.account = account;
    this.credential = credential;
  }

  seed(): Credentials {
    const { refreshToken, scope } = this.credential;
    return { refresh_token: refreshToken, scope, token_type: 'Bearer' };
  }

  secretOr(): string {
    return this.credential.clientSecret;
  }

  durable(): undefined {
    return undefined;
  }
}
