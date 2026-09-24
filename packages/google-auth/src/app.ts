import { randomUUID } from 'node:crypto';

import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';

import type { GoogleOAuthCredential } from './credential.ts';
import {
  GoogleAccountGrant,
  type GoogleGrant,
  type GoogleOpenableGrant,
} from './grant.ts';
import { GOOGLE_IDENTITY_SCOPES } from './scopes.ts';

/**
 * Everything the consent flow needs to finish the exchange. It stays with the
 * process that opened the browser and never leaves it.
 */
export interface PendingGoogleOAuthFlow {
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly dataScopes: readonly string[];
  readonly state: string;
}

export type GoogleOAuthAccountPrompt =
  | { readonly kind: 'current'; readonly googleAccountId: string }
  | { readonly kind: 'initial' }
  | { readonly kind: 'select' };

/**
 * The installed-app OAuth client Google issued to this app, and every
 * operation that needs its secret: the consent leg, a client over a grant,
 * and revocation. Google's token endpoint rejects a secret-less PKCE exchange
 * for Desktop-type clients (`invalid_request: client_secret is missing.`);
 * only Android, iOS, and Chrome client types are exempt. The installed-app
 * secret is "obviously not treated as a secret" per Google's OAuth docs;
 * gcloud embeds its own as CLOUDSDK_CLIENT_NOTSOSECRET.
 */
export class GoogleOAuthApp {
  readonly #clientId: string;
  readonly #clientSecret: string;

  constructor(options: {
    readonly clientId: string;
    readonly clientSecret: string;
  }) {
    this.#clientId = options.clientId;
    this.#clientSecret = options.clientSecret;
  }

  async authorize(
    redirectUri: string,
    dataScopes: readonly string[],
    accountPrompt: GoogleOAuthAccountPrompt,
  ): Promise<{ flow: PendingGoogleOAuthFlow; url: string }> {
    const oauth = this.#oauth(redirectUri);
    const { codeVerifier, codeChallenge } =
      await oauth.generateCodeVerifierAsync();
    const state = randomUUID();
    const requestedScopes = [
      ...new Set([...GOOGLE_IDENTITY_SCOPES, ...dataScopes]),
    ];

    return {
      flow: { codeVerifier, dataScopes, redirectUri, state },
      url: oauth.generateAuthUrl({
        access_type: 'offline',
        code_challenge: codeChallenge,
        code_challenge_method: CodeChallengeMethod.S256,
        ...(accountPrompt.kind === 'current' && {
          login_hint: accountPrompt.googleAccountId,
        }),
        prompt:
          accountPrompt.kind === 'select'
            ? 'consent select_account'
            : 'consent',
        scope: requestedScopes,
        state,
      }),
    };
  }

  /**
   * Exchanges and verifies the callback. The grant describes the permissions
   * Google actually issued; data consent checks coverage before activating it.
   */
  async complete(
    callbackUrl: string,
    flow: PendingGoogleOAuthFlow,
  ): Promise<{ grant: GoogleAccountGrant; idToken: string }> {
    const callback = new URL(callbackUrl);
    const oauthError = callback.searchParams.get('error');
    if (oauthError) {
      const detail =
        callback.searchParams.get('error_description')?.trim() || oauthError;
      throw new Error(`Google authorization failed: ${detail}`);
    }
    if (callback.searchParams.get('state') !== flow.state) {
      throw new Error('Google authorization returned an invalid state.');
    }
    const code = callback.searchParams.get('code');
    if (!code) throw new Error('Google authorization returned no code.');

    const oauth = this.#oauth(flow.redirectUri);
    const { tokens } = await oauth.getToken({
      code,
      codeVerifier: flow.codeVerifier,
      redirect_uri: flow.redirectUri,
    });
    const accessToken = tokens.access_token;
    const refreshToken = tokens.refresh_token;
    const expiresAt = tokens.expiry_date;
    const idToken = tokens.id_token;
    const scope = tokens.scope;
    if (
      !accessToken ||
      !refreshToken ||
      !expiresAt ||
      !Number.isFinite(expiresAt) ||
      !idToken ||
      !scope
    ) {
      throw new Error('Google did not return durable authorization.');
    }
    const identity = (
      await oauth.verifyIdToken({ audience: this.#clientId, idToken })
    ).getPayload();
    if (!identity?.sub || !identity.email) {
      throw new Error('Google did not return the authorized account identity.');
    }

    return {
      idToken,
      grant: new GoogleAccountGrant({
        clientId: this.#clientId,
        accessToken,
        refreshToken,
        expiresAt,
        googleAccountEmail: identity.email,
        googleAccountId: identity.sub,
        kind: 'GOOGLE_BIGQUERY_OAUTH',
        scope,
      }),
    };
  }

  /**
   * An authenticated client over a grant of any shape; the grant supplies its
   * own starting credentials and secret. The library refreshes the access
   * token on its own whenever a request finds it missing or expiring, and
   * announces every new token through its `tokens` event; `onRefreshed`
   * receives the updated credential each time so the caller can persist it.
   * Reading the client's credentials once after an eager refresh would miss
   * every refresh that happens later in a long-running pull.
   */
  client(
    grant: GoogleOpenableGrant,
    onRefreshed?: (refreshed: GoogleOAuthCredential) => void,
  ): OAuth2Client {
    const { credential } = grant;
    const oauth = new OAuth2Client({
      clientId: credential.clientId,
      clientSecret: grant.secretOr(this.#clientSecret),
    });
    oauth.setCredentials(grant.seed());
    if (onRefreshed) {
      oauth.on('tokens', (tokens) => {
        if (!tokens.access_token || !tokens.expiry_date) return;
        onRefreshed({
          ...credential,
          accessToken: tokens.access_token,
          expiresAt: tokens.expiry_date,
          refreshToken: tokens.refresh_token ?? credential.refreshToken,
          scope: tokens.scope ?? credential.scope,
        });
      });
    }
    return oauth;
  }

  // A consented grant keeps no secret of its own, so it refreshes with this
  // app's; only a grant this client issued can pair with it.
  issued(grant: GoogleGrant): boolean {
    return grant.credential.clientId === this.#clientId;
  }

  async revoke(grant: GoogleGrant): Promise<void> {
    if (!grant.revocable) return;
    await new OAuth2Client({
      clientId: grant.credential.clientId,
      clientSecret: grant.secretOr(this.#clientSecret),
    }).revokeToken(grant.credential.refreshToken);
  }

  #oauth(redirectUri: string): OAuth2Client {
    return new OAuth2Client({
      clientId: this.#clientId,
      clientSecret: this.#clientSecret,
      redirectUri,
    });
  }
}
