import type { OAuth2Client } from 'google-auth-library';

import type { GoogleGrant } from './grant.ts';

/**
 * A live client over one grant, whose tokens carry only the scopes the
 * session was opened for. `client` satisfies `GoogleRequester`; a refresh
 * token Google rotates is written back before the response that triggered the
 * refresh is returned (see `GoogleGrantOpener`).
 */
export class GoogleGrantSession {
  readonly client: OAuth2Client;
  readonly grant: GoogleGrant;

  constructor(grant: GoogleGrant, client: OAuth2Client) {
    this.grant = grant;
    this.client = client;
  }
}
