import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export class OAuthCallbackTimeoutError extends Error {
  override readonly name = 'OAuthCallbackTimeoutError';
  constructor(readonly timeoutMs: number) {
    super(
      `Google sign-in was not completed within ${Math.round(timeoutMs / 1000)} seconds.`,
    );
  }
}

export type LoopbackCallback = Disposable & {
  /** `http://127.0.0.1:<port>/callback`, the redirect a Desktop client accepts. */
  readonly redirectUri: string;
  /** The callback URL once Google redirects back carrying this `state`. */
  callback(state: string): Promise<string>;
  close(): void;
};

/**
 * Receives Google's redirect on an ephemeral loopback port. Only a redirect
 * carrying the expected `state` settles it; any other hit is refused and the
 * listener keeps waiting, so a stray request cannot end the sign-in.
 */
export async function listenForCallback({
  timeoutMs = 5 * 60_000,
}: {
  timeoutMs?: number;
} = {}): Promise<LoopbackCallback> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const answer = Promise.withResolvers<string>();
  // The timeout can fire before anyone asks for the callback.
  answer.promise.catch(() => {});
  let expected: string | undefined;
  let closed = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    clearTimeout(timeout);
    server.close();
    server.closeIdleConnections();
  };
  const timeout = setTimeout(() => {
    close();
    answer.reject(new OAuthCallbackTimeoutError(timeoutMs));
  }, timeoutMs);

  server.on('request', (request, response) => {
    const url = new URL(request.url ?? '/', redirectUri);
    if (request.method !== 'GET' || url.pathname !== '/callback') {
      response.writeHead(404, { connection: 'close' }).end();
      return;
    }
    if (expected === undefined || url.searchParams.get('state') !== expected) {
      response
        .writeHead(400, {
          connection: 'close',
          'content-type': 'text/plain; charset=utf-8',
        })
        .end('This sign-in link is not the one this app is waiting for.');
      return;
    }
    const signedIn =
      url.searchParams.has('code') && !url.searchParams.has('error');
    response
      .writeHead(200, {
        connection: 'close',
        'content-type': 'text/html; charset=utf-8',
      })
      .end(page(signedIn));
    close();
    answer.resolve(url.href);
  });

  return {
    callback(state: string) {
      if (!state) throw new TypeError('A callback needs the flow state');
      expected = state;
      return answer.promise;
    },
    close,
    redirectUri,
    [Symbol.dispose]: close,
  };
}

function page(signedIn: boolean): string {
  const heading = signedIn ? 'Signed in' : 'Sign-in failed';
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>${heading}</title><body style="font:16px system-ui;margin:4rem auto;max-width:32rem"><h1>${heading}</h1><p>You can close this tab and return to the terminal.</p></body></html>`;
}
