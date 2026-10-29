import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';

import KeyvSqlite from '@keyv/sqlite';
import got from 'got';
import { Keyv } from 'keyv';
import PQueue from 'p-queue';

export async function webHttp(
  cachePath: string,
  userAgent: string,
  signal: AbortSignal | undefined,
) {
  await using resources = new AsyncDisposableStack();
  await mkdir(dirname(cachePath), { recursive: true, mode: 0o700 });
  const file = resources.use(await open(cachePath, 'a', 0o600));
  await file.chmod(0o600);
  const cache = new Keyv<unknown>({
    store: new KeyvSqlite({
      uri: `sqlite://${cachePath}`,
      driver: 'node:sqlite',
      busyTimeout: 30_000,
    }),
  });
  resources.defer(() => cache.disconnect());
  const stop = new AbortController();
  const onCacheError = (error: unknown) => stop.abort(error);
  cache.on('error', onCacheError);
  const requestSignal =
    signal === undefined ? stop.signal : AbortSignal.any([signal, stop.signal]);
  const starts = new PQueue({
    intervalCap: 2,
    interval: 1_000,
    strict: true,
  });
  resources.defer(async () => {
    stop.abort();
    await starts.onIdle();
    cache.off('error', onCacheError);
  });
  const http = got.extend({
    cache,
    headers: { 'cache-control': 'no-cache', 'user-agent': userAgent },
    timeout: { request: 30_000 },
    retry: {
      // A socket whose local address went away, as when the Mac sleeps, fails
      // with EADDRNOTAVAIL. Got retries its siblings, such as ENETUNREACH, but not it.
      errorCodes: [...got.defaults.options.retry.errorCodes!, 'EADDRNOTAVAIL'],
    },
    hooks: {
      beforeRequest: [
        () => starts.add(() => undefined, { signal: requestSignal }),
      ],
    },
  });
  return Object.assign(resources.move(), { http, signal: requestSignal });
}
