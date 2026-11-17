import { ConfidentialClientApplication, ServerError } from '@azure/msal-node';
import { type WallClock, delay, untilAborted } from '@zukhruf/async';
import { z } from 'zod';

import {
  GraphError,
  SharePointAccessError,
  SharePointCredentialsError,
} from './errors.ts';
import { retryWait } from './graph-retry.ts';

const GRAPH = 'https://graph.microsoft.com/v1.0';

const refusedCredentials: ReadonlySet<string> = new Set([
  'invalid_client',
  'unauthorized_client',
]);

/**
 * An app registration of Microsoft Entra ID and its client secret, and the
 * clock that the retries wait on: `globalThis` in production, a fake clock in
 * a test.
 */
export type SharePointClientOptions = {
  readonly tenantId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly clock: WallClock;
};

/**
 * The GET requests of one app to Microsoft Graph. MSAL gets the app-only
 * token with the client credentials and keeps it until it expires.
 */
export class Graph {
  readonly #app: ConfidentialClientApplication;
  readonly #clock: WallClock;

  constructor({
    tenantId,
    clientId,
    clientSecret,
    clock,
  }: SharePointClientOptions) {
    this.#app = new ConfidentialClientApplication({
      auth: {
        clientId,
        clientSecret,
        authority: `https://login.microsoftonline.com/${tenantId}`,
      },
    });
    this.#clock = clock;
  }

  /**
   * A GET of `target`: a path under v1.0, or a link that Graph gave, such as
   * a nextLink. A 401 or 403 fails with a SharePointAccessError that names
   * `resource`; every other refusal fails with a GraphError.
   */
  async get(
    target: string,
    resource: string,
    signal: AbortSignal,
  ): Promise<Response> {
    const url = graphUrl(target);
    for (let attempt = 1; ; attempt += 1) {
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${await this.#token(signal)}` },
        signal,
      });
      if (response.ok) return response;
      const wait = retryWait(response, attempt, this.#clock.Date.now());
      if (wait === undefined) {
        const cause = await GraphError.of(response);
        if (cause.status === 401 || cause.status === 403)
          throw new SharePointAccessError(resource, { cause });
        throw cause;
      }
      await response.body?.cancel();
      await delay(wait, { clock: this.#clock, signal });
    }
  }

  async json<T>(
    target: string,
    schema: z.ZodType<T>,
    resource: string,
    signal: AbortSignal,
  ): Promise<T> {
    return schema.parse(
      await (await this.get(target, resource, signal)).json(),
    );
  }

  /** Every item of a collection, page after page of `@odata.nextLink`. */
  async collection<T>(
    path: string,
    item: z.ZodType<T>,
    resource: string,
    signal: AbortSignal,
  ): Promise<readonly T[]> {
    const page = z.object({
      value: z.array(item),
      '@odata.nextLink': z.string().optional(),
    });
    const items: T[] = [];
    let next: string | undefined = path;
    while (next !== undefined) {
      const body: z.infer<typeof page> = await this.json(
        next,
        page,
        resource,
        signal,
      );
      items.push(...body.value);
      next = body['@odata.nextLink'];
    }
    return items;
  }

  async #token(signal: AbortSignal): Promise<string> {
    const result = await untilAborted(
      this.#app
        .acquireTokenByClientCredential({
          scopes: ['https://graph.microsoft.com/.default'],
        })
        .catch((error: unknown) => {
          // A wrong secret answers invalid_client (AADSTS7000215, live
          // 2026-11-17); an app the tenant lacks, unauthorized_client.
          if (
            error instanceof ServerError &&
            refusedCredentials.has(error.errorCode)
          )
            throw new SharePointCredentialsError({ cause: error });
          throw error;
        }),
      signal,
    );
    if (result === null)
      throw new Error('MSAL gave no token for the client credentials');
    return result.accessToken;
  }
}

// The bearer token goes only to Graph: a link from anywhere else is refused
// before a request is sent.
function graphUrl(target: string): string {
  if (target.startsWith('/')) return `${GRAPH}${target}`;
  if (target.startsWith(`${GRAPH}/`)) return target;
  throw new TypeError(`${target} is not a Microsoft Graph v1.0 link`);
}
