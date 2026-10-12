import { DatedAnalyticsStream } from '../dated-analytics-stream.ts';
import { dayField, metricFields, settledField } from '../search-analytics.ts';
import type { SearchAnalyticsType } from '../search-console-source.ts';
import { searchConsoleFields, siteUrl } from '../search-console-stream.ts';

const properties = {
  siteUrl,
  date: dayField,
  searchType: {
    ...searchConsoleFields.id,
    description:
      'The report: WEB, IMAGE, VIDEO, NEWS, DISCOVER or GOOGLE_NEWS. Each is a separate audience, so filter to one and do not add them up.',
  },
  ...metricFields,
  settled: settledField,
};

export class SearchAnalyticsDailyStream extends DatedAnalyticsStream {
  readonly searchTypes: readonly SearchAnalyticsType[];
  protected readonly dimensions = ['date'];

  constructor(searchTypes: readonly SearchAnalyticsType[]) {
    super({
      name: 'searchAnalyticsDaily',
      description:
        'One record per property, Pacific Time day and search type: the property’s total clicks and impressions, the only authoritative totals, because the query and page breakdowns leave out anonymized traffic. Primary key siteUrl, date, searchType. A row that Google no longer returns for a day that a read gets again, from the last settled day on, is deleted; earlier days stay as loaded.',
      properties,
      primaryKey: ['siteUrl', 'date', 'searchType'],
      partitionKey: ['siteUrl'],
    });
    this.searchTypes = searchTypes;
  }

  protected override reportFields(
    searchType: SearchAnalyticsType,
  ): Record<string, unknown> {
    return { searchType };
  }
}
