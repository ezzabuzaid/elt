import type { Partition } from '@workspace/elt';
import {
  readSearchAnalytics,
  today,
} from '@workspace/sdk-google-search-console';

import { subMonths } from '../calendar-dates.ts';
import { ListingStream } from '../listing-stream.ts';
import { analyticsRecords, metricFields } from '../search-analytics.ts';
import type { SearchConsoleScan } from '../search-console-scan.ts';
import { searchConsoleFields, siteUrl } from '../search-console-stream.ts';

const { id, date } = searchConsoleFields;

const dimensions = ['country', 'device'];

// Dateless, so each row states the trailing window it totals.
const properties = {
  siteUrl,
  country: {
    ...id,
    description:
      'The searcher’s country as an ISO 3166-1 alpha-3 code in lower case, such as usa or gbr.',
  },
  device: { ...id, description: 'DESKTOP, MOBILE or TABLET.' },
  startDate: {
    ...date,
    description: 'The first Pacific Time day of the window the row totals.',
  },
  endDate: {
    ...date,
    description:
      'The last Pacific Time day of the window the row totals: the day of the read.',
  },
  ...metricFields,
};

export class SearchAnalyticsCountriesStream extends ListingStream {
  readonly #breakdownMonths: number;

  constructor(breakdownMonths: number) {
    super({
      name: 'searchAnalyticsCountries',
      description:
        'One record per property, country and device, from web search, totalled over the trailing window from startDate to endDate. Each read replaces the whole window, so the rows are not daily. Primary key siteUrl, country, device. An incremental read deletes a row that the new window does not have.',
      properties,
      primaryKey: ['siteUrl', 'country', 'device'],
      partitionKey: ['siteUrl'],
    });
    this.#breakdownMonths = breakdownMonths;
  }

  protected async list(
    partition: Partition | null,
    scan: SearchConsoleScan,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>[]> {
    const siteUrl = this.siteUrl(partition);
    const endDate = today(new Date());
    const startDate = subMonths(endDate, this.#breakdownMonths);
    const page = await readSearchAnalytics(
      scan.api,
      siteUrl,
      {
        dataState: 'ALL',
        dimensions: [...dimensions],
        endDate,
        startDate,
        type: 'WEB',
      },
      { signal },
    );
    return analyticsRecords(siteUrl, dimensions, page.rows, () => ({
      startDate,
      endDate,
    }));
  }
}
