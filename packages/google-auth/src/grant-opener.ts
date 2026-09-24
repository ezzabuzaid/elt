import type { OAuth2Client } from 'google-auth-library';

import type { GoogleOAuthApp } from './app.ts';
import type { GoogleOAuthCredential } from './credential.ts';
import { GoogleGrantMissingError, GoogleGrantRevokedError } from './errors.ts';
import { GoogleGrant, type GoogleOpenableGrant } from './grant.ts';
import { GoogleGrantSession } from './grant-session.ts';
import type { GoogleGrantStore } from './grant-store.ts';

/**
 * Opens sessions over stored grants. One instance per process; the host
 * constructs it with its store and the installed app.
 *
 * A refresh the library performs is written back through the store. Writes
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
   * The session for the grant stored under `ref`. Concurrent callers for one
   * ref share a single read and refresh, so the store sees one write per
   * rotation. The first refresh is persisted before this resolves.
   */
  open(ref: string): Promise<GoogleGrantSession> {
    const pending = this.#opening.get(ref);
    if (pending) return pending;
    const opening = this.#open(ref).finally(() => this.#opening.delete(ref));
    this.#opening.set(ref, opening);
    return opening;
  }

  /**
   * A session over a grant that is not stored yet: the connect flow proves a
   * fresh grant usable before it writes the row, and the BigQuery finder mints
   * the first token of an imported one. Refreshes are not persisted; the
   * session's grant carries the latest credential for the caller to write.
   */
  async transient(grant: GoogleOpenableGrant): Promise<GoogleGrantSession> {
    let durable = grant.durable();
    const client = this.#app.client(grant, (refreshed) => {
      durable = new GoogleGrant(refreshed);
    });
    await this.#assertUsable(client, grant);
    if (!durable) {
      // A client with no access token refreshes on its first getAccessToken
      // and emits `tokens` before resolving (google-auth-library
      // oauth2client.js getAccessTokenAsync → refreshAccessTokenAsync).
      throw new Error(
        'google-auth-library resolved getAccessToken without minting a token.',
      );
    }
    return new GoogleGrantSession(durable, client);
  }

  revoke(credential: GoogleOAuthCredential): Promise<void> {
    return this.#app.revoke(new GoogleGrant(credential));
  }

  async #open(ref: string): Promise<GoogleGrantSession> {
    const grant = GoogleGrant.parse(await this.#store.read(ref));
    if (!grant) throw new GoogleGrantMissingError(ref);
    let persisted = Promise.resolve();
    const client = this.#app.client(grant, (refreshed) => {
      persisted = persisted.then(() => this.#store.write(ref, refreshed));
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

  /**
   * Proves the grant still refreshes before any work is queued on it. The
   * `tokens` listener has already received the refreshed token by the time
   * this resolves.
   */
  async #assertUsable(
    client: OAuth2Client,
    grant: GoogleOpenableGrant,
  ): Promise<void> {
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
