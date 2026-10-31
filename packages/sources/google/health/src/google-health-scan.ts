import pMemoize from 'p-memoize';

import {
  type CivilDate,
  type DataPoint,
  type GoogleHealthApi,
  LISTED_DATA_TYPES,
  type ListedDataType,
} from '@workspace/sdk-google-health';

import { calendarDate } from './health-fields.ts';

/**
 * One run's reads of Google Health. The streams of one data type and its
 * child lists (a sleep and its stages) read the same points, fetched once per
 * run, so they agree; every other type streams its points without holding
 * them. The day the user's Google Health history starts, where daily types
 * and rollups begin, is read once. A read that failed is not kept: the next
 * stream to ask reads it again.
 */
export class GoogleHealthScan implements AsyncDisposable {
  readonly api: GoogleHealthApi;

  constructor(api: GoogleHealthApi) {
    this.api = api;
  }

  /** Every point of a type, read for this stream alone. */
  async *points(
    type: ListedDataType,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<DataPoint> {
    yield* this.api.dataPoints(type, {
      ...(LISTED_DATA_TYPES[type].daily && { since: await this.since(signal) }),
      ...(signal && { signal }),
    });
  }

  /** Every point of a type, read once for all the streams that read it. */
  readonly shared = pMemoize(
    (
      type: ListedDataType,
      signal: AbortSignal | undefined,
    ): Promise<DataPoint[]> => Array.fromAsync(this.points(type, signal)),
  );

  /**
   * The day the user joined, from their profile. Google answers daily types
   * for every date, recorded or not, so this is where their history starts.
   */
  readonly since = pMemoize(
    async (signal: AbortSignal | undefined): Promise<CivilDate> => {
      const { membershipStartDate } = await this.api.profile(
        signal && { signal },
      );
      const date = calendarDate(membershipStartDate);
      if (date === null)
        throw new TypeError(
          'The Google Health profile names no membershipStartDate, so daily data has no start',
        );
      return date;
    },
    // One profile per run, whichever stream's signal asks.
    { cacheKey: () => 'profile' },
  );

  async [Symbol.asyncDispose](): Promise<void> {}
}
