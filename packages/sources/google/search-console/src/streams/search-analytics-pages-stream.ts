import { DatedAnalyticsStream } from '../dated-analytics-stream.ts';
import { dayField, metricFields, settledField } from '../search-analytics.ts';
import { searchConsoleFields, siteUrl } from '../search-console-stream.ts';

const properties = {
  siteUrl,
  date: dayField,
  page: {
    ...searchConsoleFields.id,
    description: 'The full URL of the page that Google showed in results.',
  },
  ...metricFields,
  settled: settledField,
};

export class SearchAnalyticsPagesStream extends DatedAnalyticsStream {
  readonly searchTypes = ['WEB'] as const;
  protected readonly dimensions = ['date', 'page'];

  constructor() {
    super({
      name: 'searchAnalyticsPages',
      description:
        'One record per property, Pacific Time day and landing page, from web search. Google counts per page, so these rows do not add up to searchAnalyticsDaily. Primary key siteUrl, date, page. A row that Google no longer returns for a day that a read gets again, from the last settled day on, is deleted; earlier days stay as loaded.',
      properties,
      primaryKey: ['siteUrl', 'date', 'page'],
      partitionKey: ['siteUrl'],
    });
  }
}
