import type { OAuth2Client } from 'google-auth-library';

import type { GoogleGrant } from './grant.ts';

/**
 * A live client over one grant. `client` satisfies `GoogleRequester` and is
 * what the BigQuery adapter takes; when the session was opened from a store,
 * every token refresh the client performs is written back before the response
 * that triggered it is returned (see `GoogleGrantOpener`).
 */
export class GoogleGrantSession {
  readonly client: OAuth2Client;
  readonly grant: GoogleGrant;

  constructor(grant: GoogleGrant, client: OAuth2Client) {
    this.grant = grant;
    this.client = client;
  }
}
