import { type Clock, delay } from '@zukhruf/async';

import {
  type GoogleRequester,
  attemptsOf,
  googleRetry,
  isRateLimit,
  reasonsOf,
} from '@eltjs/google-auth';

import {
  LISTED_DATA_TYPES,
  type ListedDataType,
  ROLLED_UP_DATA_TYPES,
  type RolledUpDataType,
} from './data-types.ts';
import {
  GoogleHealthAccountNotLinkedError,
  GoogleHealthRateLimitError,
} from './errors.ts';
import {
  type DailyRollupDataPoint,
  type DataPoint,
  type PairedDevice,
  dailyRollUpDataPointsResponse,
  exportExerciseTcxResponse,
  identity,
  irnProfile,
  listDataPointsResponse,
  listPairedDevicesResponse,
  profile,
  settings,
} from './responses.ts';

const BASE = 'https://health.googleapis.com/v4/';

/**
 * Google Health's per-user quota: 300 requests a minute
 * (developers.google.com/health/rate-limits). Streams that read at once share
 * it, and daily rollups send many small requests fast, so every request
 * waits for room under it.
 */
const REQUESTS_PER_MINUTE = 300;

// Google Health names its rate limit in an ErrorInfo detail (AIP-193); its
// error catalog gives RESOURCE_EXHAUSTED for quota.
const RATE_LIMIT_REASONS = ['RESOURCE_EXHAUSTED'];

/**
 * The most points a list request asks for. Google answers fewer per page
 * (about 5,000 for heart rate, 25 for sleep and exercise, live 2026-10-15),
 * and the read follows nextPageToken to the end either way.
 */
const PAGE_SIZE = '10000';

/** The time and the timers of a caller: a host gives globalThis, a test a fake clock that it moves. */
export type GoogleHealthClock = Clock & { readonly Date: { now(): number } };

/** A call stops when signal aborts, and paces and waits its retries on clock. */
export type CallOptions = {
  readonly signal?: AbortSignal;
  readonly clock: GoogleHealthClock;
};

/** A calendar date, `YYYY-MM-DD`. */
export type CivilDate = string;

/** The Google Health API v4 for the signed-in user (`users/me`). */
export class GoogleHealthApi {
  readonly #requester: GoogleRequester;
  // When each request of the last minute started.
  readonly #starts: number[] = [];

  constructor(requester: GoogleRequester) {
    if (typeof requester?.request !== 'function')
      throw new TypeError('Google Health requires an authenticated requester');
    this.#requester = requester;
    Object.freeze(this);
  }

  async identity(options: CallOptions) {
    return identity.parse(await this.#get('users/me/identity', {}, options));
  }

  async profile(options: CallOptions) {
    return profile.parse(await this.#get('users/me/profile', {}, options));
  }

  async settings(options: CallOptions) {
    return settings.parse(await this.#get('users/me/settings', {}, options));
  }

  async irnProfile(options: CallOptions) {
    return irnProfile.parse(
      await this.#get('users/me/irnProfile', {}, options),
    );
  }

  async *pairedDevices(options: CallOptions): AsyncGenerator<PairedDevice> {
    let pageToken: string | undefined;
    do {
      const page = listPairedDevicesResponse.parse(
        await this.#get(
          'users/me/pairedDevices',
          pageToken === undefined ? {} : { pageToken },
          options,
        ),
      );
      yield* page.pairedDevices ?? [];
      pageToken = page.nextPageToken;
    } while (pageToken);
  }

  /**
   * Every point of a data type, newest first, following nextPageToken to its
   * end. A daily type reads from `since` on; it has a point for every date.
   */
  async *dataPoints(
    type: ListedDataType,
    options: CallOptions & { readonly since?: CivilDate },
  ): AsyncGenerator<DataPoint> {
    const query: Record<string, string> = { pageSize: PAGE_SIZE };
    if (options.since !== undefined) {
      if (!LISTED_DATA_TYPES[type].daily)
        throw new TypeError(
          `Only a daily data type is read from a date; ${type} is not one`,
        );
      query.filter = `${type.replaceAll('-', '_')}.date >= "${options.since}"`;
    }
    let pageToken: string | undefined;
    do {
      const page = listDataPointsResponse.parse(
        await this.#get(
          `users/me/dataTypes/${type}/dataPoints`,
          pageToken === undefined ? query : { ...query, pageToken },
          options,
        ),
      );
      yield* page.dataPoints ?? [];
      pageToken = page.nextPageToken;
    } while (pageToken);
  }

  /** The most recent point of a data type, or undefined when it has none. */
  async newest(type: ListedDataType, options: CallOptions) {
    const page = listDataPointsResponse.parse(
      await this.#get(
        `users/me/dataTypes/${type}/dataPoints`,
        { pageSize: '1' },
        options,
      ),
    );
    return page.dataPoints?.[0];
  }

  /**
   * One rollup per day from `start` up to `end` (exclusive). A request may
   * span only the days the type allows, and its page must cover its whole
   * range, so the range is asked for in windows of that length.
   */
  async *dailyRollUp(
    type: RolledUpDataType,
    range: { readonly start: CivilDate; readonly end: CivilDate },
    options: CallOptions,
  ): AsyncGenerator<DailyRollupDataPoint> {
    const { maxDays } = ROLLED_UP_DATA_TYPES[type];
    let start = range.start;
    while (start < range.end) {
      const next = minDate(addDays(start, maxDays), range.end);
      const page = dailyRollUpDataPointsResponse.parse(
        await this.#send(
          'POST',
          `users/me/dataTypes/${type}/dataPoints:dailyRollUp`,
          {
            data: {
              pageSize: daysBetween(start, next),
              range: { end: civil(next), start: civil(start) },
              windowSizeDays: 1,
            },
          },
          options,
        ),
      );
      yield* page.rollupDataPoints ?? [];
      start = next;
    }
  }

  /**
   * An exercise's route and samples as a TCX document, or undefined when
   * Google keeps none. `name` is the exercise point's resource name.
   */
  async exerciseTcx(name: string, options: CallOptions) {
    return exportExerciseTcxResponse.parse(
      await this.#get(
        `${name}:exportExerciseTcx`,
        { partialData: 'true' },
        options,
      ),
    ).tcxData;
  }

  #get(
    path: string,
    query: Readonly<Record<string, string>>,
    options: CallOptions,
  ): Promise<unknown> {
    const search = new URLSearchParams(query).toString();
    return this.#send('GET', search ? `${path}?${search}` : path, {}, options);
  }

  /**
   * An abort cancels both the request in flight and any retry wait. gaxios
   * wraps a cancelled fetch in a generic error, so the signal's own reason is
   * rethrown to keep an abort recognizable as one.
   */
  async #send(
    method: 'GET' | 'POST',
    path: string,
    { data }: { readonly data?: Record<string, unknown> },
    { signal, clock }: CallOptions,
  ): Promise<unknown> {
    const retry = googleRetry({
      clock,
      signal,
      rateLimitReasons: RATE_LIMIT_REASONS,
    });
    await this.#pace(signal, clock);
    try {
      const response = await this.#requester.request({
        method,
        url: `${BASE}${path}`,
        ...(data === undefined ? {} : { data }),
        ...(signal === undefined ? {} : { signal }),
        retry: true,
        retryConfig: {
          ...retry.retryConfig,
          // A retry is one more request of the minute, so it waits for room
          // under the quota after its back-off.
          retryBackoff: async (error) => {
            await retry.retryConfig.retryBackoff(error);
            await this.#pace(signal, clock);
          },
        },
      });
      return response.data;
    } catch (cause) {
      signal?.throwIfAborted();
      if (reasonsOf(cause).includes('ACCOUNT_NOT_LINKED'))
        throw new GoogleHealthAccountNotLinkedError({ cause });
      if (!isRateLimit(cause, RATE_LIMIT_REASONS)) throw cause;
      const attempts = attemptsOf(cause);
      throw new GoogleHealthRateLimitError(
        attempts,
        `Google Health rate limited ${method} ${path} after ${attempts} ${attempts === 1 ? 'attempt' : 'attempts'}`,
        { cause },
      );
    }
  }

  // Waits until a request started now stays under the per-minute quota.
  async #pace(
    signal: AbortSignal | undefined,
    clock: GoogleHealthClock,
  ): Promise<void> {
    for (;;) {
      const now = clock.Date.now();
      while (this.#starts.length > 0 && now - (this.#starts[0] ?? 0) >= 60_000)
        this.#starts.shift();
      const [oldest] = this.#starts;
      if (oldest === undefined || this.#starts.length < REQUESTS_PER_MINUTE) {
        this.#starts.push(now);
        return;
      }
      await delay(60_000 - (now - oldest), { clock, signal });
    }
  }
}

const DAY_MS = 86_400_000;

function addDays(date: CivilDate, days: number): CivilDate {
  return new Date(Date.parse(date) + days * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(start: CivilDate, end: CivilDate): number {
  return (Date.parse(end) - Date.parse(start)) / DAY_MS;
}

function minDate(a: CivilDate, b: CivilDate): CivilDate {
  return a < b ? a : b;
}

function civil(date: CivilDate) {
  const [year, month, day] = date.split('-').map(Number);
  return { date: { day, month, year } };
}
