import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';

import KeyvSqlite from '@keyv/sqlite';
import got, { type Got } from 'got';
import { Keyv } from 'keyv';
import { z } from 'zod';

import type { PipelineClock } from '@workspace/elt';
import {
  type OriginMemento,
  Origins,
  type Reader,
  type RevisitPolicy,
} from '@workspace/sdk-web-crawler';

import type { ExtractorRun } from '../record-extractor.ts';

// A row of the origins table: its key is the origin.
const storedOrigin = z.tuple([z.string(), z.unknown()]);

/**
 * The HTTP of one read: the cache, and the record of each origin that every
 * crawl of the read shares. The records live next to the HTTP cache, in its
 * file, as Nutch keeps its HostDb beside its crawl database, so a slowdown,
 * a block and robots.txt rules outlive the read.
 */
export class WebClient implements AsyncDisposable {
  /** Aborts when the read's signal does, or when the cache fails. */
  readonly signal: AbortSignal;
  readonly #http: Got;
  readonly #origins: Origins;
  readonly #store: Keyv<unknown>;
  // Each origin's record as the store holds it, so a save writes only what changed.
  readonly #saved: Map<string, OriginMemento>;
  readonly #resources: AsyncDisposableStack;

  private constructor(
    http: Got,
    origins: Origins,
    store: Keyv<unknown>,
    signal: AbortSignal,
    resources: AsyncDisposableStack,
  ) {
    this.#http = http;
    this.#origins = origins;
    this.#store = store;
    this.signal = signal;
    this.#resources = resources;
    this.#saved = new Map(Object.entries(origins.snapshot()));
  }

  /** Opens the cache in cachePath, creating its folder, and reads the records of the origins, which wait and read the time on clock. */
  static async open(
    cachePath: string,
    userAgent: string | undefined,
    signal: AbortSignal | undefined,
    clock: PipelineClock,
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
    const store = new Keyv<unknown>({
      store: new KeyvSqlite({
        uri: `sqlite://${cachePath}`,
        driver: 'node:sqlite',
        busyTimeout: 30_000,
        table: 'origins',
      }),
    });
    resources.defer(() => store.disconnect());
    const stop = new AbortController();
    const onCacheError = (error: unknown) => stop.abort(error);
    cache.on('error', onCacheError);
    store.on('error', onCacheError);
    resources.defer(() => {
      stop.abort();
      cache.off('error', onCacheError);
      store.off('error', onCacheError);
    });
    const http = got.extend({
      cache,
      headers: { 'cache-control': 'no-cache', 'user-agent': userAgent },
      // One attempt may last 30 seconds, its body included: Heritrix allows
      // 20 seconds of socket silence and Nutch 10, and a whole answer, such
      // as a 50 MB sitemap, takes longer than one silence.
      timeout: { request: 30_000 },
      retry: {
        // A socket whose local address went away, as when the Mac sleeps, fails
        // with EADDRNOTAVAIL. Got retries its siblings, such as ENETUNREACH, but not it.
        errorCodes: [
          ...got.defaults.options.retry.errorCodes!,
          'EADDRNOTAVAIL',
        ],
      },
    });
    const stored: Record<string, unknown> = {};
    for await (const row of store.iterator()) {
      const [origin, record] = storedOrigin.parse(row);
      stored[origin] = record;
    }
    return new WebClient(
      http,
      new Origins(http, stored, clock),
      store,
      signal === undefined
        ? stop.signal
        : AbortSignal.any([signal, stop.signal]),
      resources.move(),
    );
  }

  /** The client for requests outside a crawl's frontier, such as an extractor's: each passes the record of its origin. */
  get http() {
    return this.#origins.http;
  }

  /**
   * A crawler for one input, with the revisit policy of its copy. Its pages
   * ask with the extractor's negotiation, whose hook marks a redirect that
   * the negotiation chose; the crawler carries the mark to the request that
   * the redirect makes.
   */
  crawler(
    readers: readonly Reader<unknown, unknown>[],
    revisit: RevisitPolicy<unknown>,
    negotiation: ExtractorRun['negotiation'],
  ) {
    return this.#origins.crawler(
      negotiation === null
        ? this.#http
        : this.#http.extend({
            hooks: {
              beforeRequest: [
                (options) => {
                  if (options.context.page === true)
                    options.headers.accept = negotiation.accept;
                },
              ],
              afterResponse: [negotiation.afterResponse],
            },
          }),
      readers,
      revisit,
    );
  }

  /** Writes each origin's record that changed since the last save. */
  async save() {
    const changed = Object.entries(this.#origins.snapshot()).filter(
      ([origin, record]) => this.#saved.get(origin) !== record,
    );
    if (changed.length === 0) return;
    await this.#store.setMany(changed.map(([key, value]) => ({ key, value })));
    for (const [origin, record] of changed) this.#saved.set(origin, record);
  }

  async [Symbol.asyncDispose]() {
    await using resources = this.#resources;
    await this.save();
  }
}
