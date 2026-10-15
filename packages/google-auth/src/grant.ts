import type {
  GoogleDataGrantCredential,
  GoogleOAuthCredential,
} from './credential.ts';

/** A stored grant, read-only, with the questions hosts ask of it. */
export class GoogleGrant {
  readonly #credential: GoogleOAuthCredential;
  readonly #scopes: ReadonlySet<string>;

  // The store holds other secrets too; a grant this package wrote says so in
  // its kind. Anything else, or nothing, is no grant.
  static parse(value: unknown): GoogleGrant | undefined {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- only a grant this package wrote carries its kind; any other secret fails the kind check below
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
}

/**
 * A grant that knows which Google account it belongs to. Every grant
 * completed through this app's own consent flow is one, because the identity
 * scopes are always requested.
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
