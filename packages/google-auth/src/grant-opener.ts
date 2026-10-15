import type { OAuth2Client } from 'google-auth-library';

import type { GoogleOAuthApp } from './app.ts';
import type { GoogleOAuthCredential } from './credential.ts';
import { GoogleGrantMissingError, GoogleGrantRevokedError } from './errors.ts';
import { GoogleGrantSession } from './grant-session.ts';
import type { GoogleGrantStore } from './grant-store.ts';
import { GoogleGrant } from './grant.ts';

/**
 * Opens sessions over stored grants. One instance per process; the host
 * constructs it with its store and the installed app.
 *
 * A refresh token Google rotates is written back through the store. Writes
 * chain in order, and the client's own transporter awaits the chain before it
 * returns any response, so the request that triggered a failed write rejects
 * with the write error (gaxios response interceptors,
 * `node_modules/gaxios/build/cjs/src/gaxios.js` `#applyResponseInterceptors`).
 * Nothing is logged or swallowed.
 */
export class GoogleGrantOpener {
  readonly #app: GoogleOAuthApp;
  readonly #opening = new Map<string, Promise<GoogleGrantSession>>();
  readonly #store: GoogleGrantStore;

  constructor(options: {
    readonly app: GoogleOAuthApp;
    readonly store: GoogleGrantStore;
  }) {
    this.#app = options.app;
    this.#store = options.store;
  }

  /**
   * The session for the grant stored under `ref`, whose tokens carry only
   * `scopes`. Concurrent callers for one ref and the same scopes share a
   * single read and refresh. The first refresh has run before this resolves.
   */
  open(ref: string, scopes: readonly string[]): Promise<GoogleGrantSession> {
    const key = JSON.stringify([ref, scopes]);
    const pending = this.#opening.get(key);
    if (pending) return pending;
    const opening = this.#open(ref, scopes).finally(() =>
      this.#opening.delete(key),
    );
    this.#opening.set(key, opening);
    return opening;
  }

  revoke(credential: GoogleOAuthCredential): Promise<void> {
    return this.#app.revoke(new GoogleGrant(credential));
  }

  async #open(
    ref: string,
    scopes: readonly string[],
  ): Promise<GoogleGrantSession> {
    const grant = GoogleGrant.parse(await this.#store.read(ref));
    if (!grant) throw new GoogleGrantMissingError(ref);
    let persisted = Promise.resolve();
    const client = this.#app.client(grant, scopes, (rotated) => {
      persisted = persisted.then(() => this.#store.write(ref, rotated));
    });
    client.transporter.interceptors.response.add({
      resolved: async (response) => {
        await persisted;
        return response;
      },
    });
    await this.#assertUsable(client, grant);
    await persisted;
    return new GoogleGrantSession(grant, client);
  }

  /** Proves the grant still refreshes before any work is queued on it. */
  async #assertUsable(client: OAuth2Client, grant: GoogleGrant): Promise<void> {
    try {
      await client.getAccessToken();
    } catch (error) {
      if (GoogleGrantRevokedError.matches(error)) {
        throw new GoogleGrantRevokedError(grant.credential);
      }
      throw error;
    }
  }
}
