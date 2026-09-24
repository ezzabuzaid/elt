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

  static parse(value: unknown): GoogleGrant | undefined {
    return GoogleGrant.#isCredential(value)
      ? new GoogleGrant(value)
      : undefined;
  }

  static #isCredential(value: unknown): value is GoogleOAuthCredential {
    return (
      typeof value === 'object' &&
      value !== null &&
      'kind' in value &&
      value.kind === 'GOOGLE_BIGQUERY_OAUTH' &&
      'clientId' in value &&
      typeof value.clientId === 'string' &&
      (!('clientSecret' in value) ||
        value.clientSecret === undefined ||
        typeof value.clientSecret === 'string') &&
      'accessToken' in value &&
      typeof value.accessToken === 'string' &&
      'refreshToken' in value &&
      typeof value.refreshToken === 'string' &&
      'expiresAt' in value &&
      typeof value.expiresAt === 'number' &&
      Number.isFinite(value.expiresAt) &&
      'scope' in value &&
      typeof value.scope === 'string' &&
      (!('externallyManaged' in value) ||
        value.externallyManaged === undefined ||
        typeof value.externallyManaged === 'boolean')
    );
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
      typeof credential.googleAccountId === 'string' &&
      typeof credential.googleAccountEmail === 'string'
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
    if (
      typeof value !== 'object' ||
      value === null ||
      !('type' in value) ||
      value.type !== 'authorized_user'
    ) {
      return undefined;
    }
    const clientId = GoogleImportedGrant.#text(value, 'client_id');
    const clientSecret = GoogleImportedGrant.#text(value, 'client_secret');
    const refreshToken = GoogleImportedGrant.#text(value, 'refresh_token');
    if (!clientId || !clientSecret || !refreshToken) return undefined;
    return new GoogleImportedGrant(
      GoogleImportedGrant.#text(value, 'account') ?? options.account,
      {
        clientId,
        clientSecret,
        externallyManaged: true,
        kind: 'GOOGLE_BIGQUERY_OAUTH',
        refreshToken,
        scope: options.scope,
      },
    );
  }

  static #text(value: object, key: string): string | undefined {
    const field: unknown = Reflect.get(value, key);
    const text = typeof field === 'string' ? field.trim() : '';
    return text || undefined;
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
