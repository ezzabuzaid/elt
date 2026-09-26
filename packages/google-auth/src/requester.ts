/**
 * The one method a Google product call needs from an authenticated client.
 * `OAuth2Client` satisfies it as written (`requester.test.ts` pins that against
 * the real class), so production passes the client and a test passes a stub
 * without either side knowing about the other.
 *
 * Deliberately not generic in the response. A generic `request<T>` forces every
 * stub to assert its return value into `T`, and
 * `@typescript-eslint/consistent-type-assertions` bans assertions repo-wide.
 * Each product module narrows the `unknown` body with its own guard at the one
 * place it reads it.
 */
export interface GoogleRequester {
  request(options: {
    readonly url: string;
    readonly method?: 'GET' | 'POST';
    readonly data?: Record<string, unknown>;
    readonly signal?: AbortSignal;
    readonly headers?: Readonly<Record<string, string>>;
    // 'arraybuffer' returns a file download's bytes instead of parsed JSON.
    readonly responseType?: 'json' | 'arraybuffer';
  }): Promise<{ readonly data: unknown }>;
}
