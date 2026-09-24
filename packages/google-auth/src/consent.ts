import type { GoogleOAuthApp, PendingGoogleOAuthFlow } from './app.ts';
import type { GoogleActiveGrant } from './grant-store.ts';
import type { GoogleGrantVault } from './grant-vault.ts';

/**
 * What crosses the gap between `begin` and `finish`: plain data, so a host
 * can hold it in memory for a loopback callback or store it by `flow.state`
 * when the callback arrives in another request.
 */
export interface GoogleConsentTicket {
  readonly userId: string;
  readonly flow: PendingGoogleOAuthFlow;
}

/**
 * Consent in two halves. `begin` decides what to ask Google for and mints the
 * URL; the host shows it and waits its own way; `finish` turns the answer
 * into the user's active grant. The object holds nothing between the two.
 */
export class GoogleConsent {
  readonly #app: GoogleOAuthApp;
  readonly #vault: GoogleGrantVault;

  constructor(options: {
    readonly app: GoogleOAuthApp;
    readonly vault: GoogleGrantVault;
  }) {
    this.#app = options.app;
    this.#vault = options.vault;
  }

  /** The active grant, when it already covers the scopes and the user keeps the account. */
  async current(
    userId: string,
    dataScopes: readonly string[],
    options: { readonly differentAccount: boolean },
  ): Promise<GoogleActiveGrant | undefined> {
    if (options.differentAccount) return undefined;
    const active = await this.#vault.active(userId);
    return active?.grant.covers(dataScopes) ? active : undefined;
  }

  /**
   * The URL to show the user. Keeping the account asks for the union of what
   * the grant has and what is needed, so the new grant replaces the old one
   * without losing a scope; a different account starts from the data scopes.
   */
  async begin(
    userId: string,
    dataScopes: readonly string[],
    options: {
      readonly differentAccount: boolean;
      readonly redirectUri: string;
    },
  ): Promise<{ url: string; ticket: GoogleConsentTicket }> {
    const active = await this.#vault.active(userId);
    const keepAccount = active && !options.differentAccount;
    const { flow, url } = await this.#app.authorize(
      options.redirectUri,
      keepAccount
        ? [...new Set([...active.grant.scopes, ...dataScopes])]
        : dataScopes,
      options.differentAccount
        ? { kind: 'select' }
        : active
          ? { googleAccountId: active.grant.account.id, kind: 'current' }
          : { kind: 'initial' },
    );
    return { ticket: { flow, userId }, url };
  }

  /** Exchanges the callback for a grant and makes it the user's active one. */
  async finish(
    ticket: GoogleConsentTicket,
    callbackUrl: string,
  ): Promise<GoogleActiveGrant> {
    const { grant } = await this.#app.complete(callbackUrl, ticket.flow);
    if (!grant.covers(ticket.flow.dataScopes)) {
      throw new Error(
        'Google did not return durable authorization for every requested permission.',
      );
    }
    const ref = await this.#vault.save(ticket.userId, grant);
    return { grant, ref };
  }
}
