import type { SearchConsoleApi } from '../../platform/google/search-console-api.ts';

export type UrlInspection = {
  readonly inspectionUrl: string;
  readonly result: Record<string, unknown>;
  readonly indexStatus: Record<string, unknown>;
};

function record(value: unknown, key: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object') return {};
  const nested: unknown = Reflect.get(value, key);
  return nested !== null && typeof nested === 'object'
    ? (nested as Record<string, unknown>)
    : {};
}

/**
 * Inspects each URL in turn, pausing between batches so a long list stays
 * under the per-minute ceiling. Sequential by design: the quota is per
 * property, so concurrency buys nothing and risks a burst refusal.
 */
export async function inspectUrls(
  api: SearchConsoleApi,
  siteUrl: string,
  urls: readonly string[],
  { signal }: { signal?: AbortSignal } = {},
): Promise<UrlInspection[]> {
  const inspections: UrlInspection[] = [];
  for (const inspectionUrl of urls) {
    signal?.throwIfAborted();
    const body = await api.inspect(siteUrl, inspectionUrl);
    const result = record(body, 'inspectionResult');
    inspections.push({
      inspectionUrl,
      result,
      indexStatus: record(result, 'indexStatusResult'),
    });
  }
  return inspections;
}

export function inspectionTexts(values: unknown): readonly string[] {
  return Array.isArray(values)
    ? values.filter((value): value is string => typeof value === 'string')
    : [];
}
