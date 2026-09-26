import { setTimeout as wait } from 'node:timers/promises';

import { messageOf, statusOf } from 'google-auth';
import {
  type InspectionResult,
  type SearchConsoleApi,
  SearchConsoleQuotaError,
  URL_INSPECTION_QUOTA,
} from '../../platform/google/search-console-api.ts';

export type UrlInspection = {
  readonly inspectionUrl: string;
  readonly inspectedAt: string;
  // Null when Google rejected this one URL; error then says why.
  readonly result: InspectionResult | null;
  readonly error: { readonly status: number; readonly message: string } | null;
};

export type InspectionClock = {
  now(): number;
  sleep(ms: number): Promise<void>;
};

export const systemInspectionClock: InspectionClock = {
  now: () => Date.now(),
  sleep: (ms) => wait(ms),
};

// A bad URL is Google's verdict on that URL alone; anything else (auth, a
// revoked property, a server fault) would fail every URL the same way.
const REJECTED_URL_STATUSES = new Set([400, 404]);

/**
 * Inspects URLs concurrently, in the given order. Each call waits seconds on
 * Google, so the pool keeps `concurrency` in flight while pacing starts under
 * the per-minute ceiling; a quota refusal can then only mean the daily quota.
 * On that refusal no new call starts, the ones in flight finish, and the
 * inspections that succeeded are returned with `exhausted` set.
 */
export async function inspectUrls(
  api: SearchConsoleApi,
  siteUrl: string,
  urls: readonly string[],
  {
    concurrency,
    clock = systemInspectionClock,
  }: { concurrency: number; clock?: InspectionClock },
): Promise<{ inspections: UrlInspection[]; exhausted: boolean }> {
  const results: (UrlInspection | undefined)[] = [];
  const controller = new AbortController();
  const starts: number[] = [];
  let next = 0;
  let exhausted = false;
  let failure: { error: unknown } | undefined;

  const pace = async () => {
    for (;;) {
      const now = clock.now();
      while (starts.length > 0 && now - (starts[0] ?? 0) >= 60_000)
        starts.shift();
      if (starts.length < URL_INSPECTION_QUOTA.perMinute) {
        starts.push(now);
        return;
      }
      await clock.sleep(60_000 - (now - (starts[0] ?? 0)));
    }
  };

  const worker = async () => {
    while (!exhausted && failure === undefined && next < urls.length) {
      const index = next++;
      const inspectionUrl = urls[index] ?? '';
      await pace();
      if (exhausted || failure !== undefined) return;
      try {
        const { inspectionResult } = await api.inspect(siteUrl, inspectionUrl, {
          signal: controller.signal,
        });
        results[index] = {
          inspectionUrl,
          inspectedAt: new Date(clock.now()).toISOString(),
          result: inspectionResult ?? {},
          error: null,
        };
      } catch (error) {
        const status = statusOf(error);
        if (error instanceof SearchConsoleQuotaError) exhausted = true;
        else if (status !== undefined && REJECTED_URL_STATUSES.has(status))
          results[index] = {
            inspectionUrl,
            inspectedAt: new Date(clock.now()).toISOString(),
            result: null,
            error: { status, message: messageOf(error) },
          };
        else if (failure === undefined) {
          failure = { error };
          controller.abort();
        }
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, urls.length) }, worker),
  );
  if (failure !== undefined) throw failure.error;
  return {
    inspections: results.filter(
      (inspection): inspection is UrlInspection => inspection !== undefined,
    ),
    exhausted,
  };
}
