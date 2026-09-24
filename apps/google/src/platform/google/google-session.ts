import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  GoogleConsent,
  GoogleGrantOpener,
  GoogleGrantRevokedError,
  GoogleGrantVault,
  GoogleOAuthApp,
  type GoogleRequester,
} from 'google-auth';

import { GrantFiles } from './grant-files.ts';
import { listenForCallback } from './loopback-callback.ts';
import { openBrowser as openInBrowser } from './open-browser.ts';

// The grant directory already belongs to one OS user, so one local user id is
// enough; the vault hashes it before it reaches a file name.
const USER = 'local';

export function grantDirectory(): string {
  return join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
    'mac-elt',
  );
}

export type GoogleSessionOptions = {
  /** A Desktop-type OAuth client; its project is billed for API quota. */
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scopes: readonly string[];
  readonly directory?: string;
  readonly openBrowser?: (url: string) => Promise<void>;
  readonly timeoutMs?: number;
};

/**
 * An authenticated requester for the stored Google grant. Consent runs only
 * when no stored grant covers the scopes, or when Google no longer honors the
 * stored one; every refresh is written back before the call that caused it
 * returns.
 */
export async function googleSession({
  clientId,
  clientSecret,
  scopes,
  directory = grantDirectory(),
  openBrowser = openInBrowser,
  timeoutMs,
}: GoogleSessionOptions): Promise<GoogleRequester> {
  if (!clientId || !clientSecret)
    throw new TypeError('A Google session needs an OAuth client id and secret');
  const app = new GoogleOAuthApp({ clientId, clientSecret });
  const store = new GrantFiles(directory);
  const vault = new GoogleGrantVault({ directory: 'google', store });
  const consent = new GoogleConsent({ app, vault });
  const opener = new GoogleGrantOpener({ app, store });

  const authorize = async (): Promise<string> => {
    using listener = await listenForCallback({
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    const { ticket, url } = await consent.begin(USER, scopes, {
      differentAccount: false,
      redirectUri: listener.redirectUri,
    });
    const answered = listener.callback(ticket.flow.state);
    await openBrowser(url);
    return (await consent.finish(ticket, await answered)).ref;
  };

  const current = await consent.current(USER, scopes, {
    differentAccount: false,
  });
  if (!current) return (await opener.open(await authorize())).client;
  try {
    return (await opener.open(current.ref)).client;
  } catch (error) {
    // Revoked consent, an expired refresh token, or a Workspace
    // re-authentication demand: the only remedy is to connect again.
    if (!(error instanceof GoogleGrantRevokedError)) throw error;
    return (await opener.open(await authorize())).client;
  }
}
