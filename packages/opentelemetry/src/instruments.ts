import {
  type Counter,
  type Histogram,
  type Meter,
  ValueType,
} from '@opentelemetry/api';

import { type CrawlRequested, priorities } from '@workspace/sdk-web-crawler';

// OpenTelemetry's buckets for HTTP durations in seconds, with 30 and 60 for a
// crawl's slow pages and long waits.
const seconds = {
  unit: 's',
  valueType: ValueType.DOUBLE,
  advice: {
    explicitBucketBoundaries: [
      0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10,
      30, 60,
    ],
  },
};

/** The instruments of one meter: the base makes them again for each meter that the host sets. */
export class Instruments {
  readonly requests: Counter;
  readonly requestDuration: Histogram;
  readonly requestWait: Histogram;
  readonly handOffDuration: Histogram;
  readonly extractDuration: Histogram;
  readonly committed: Counter;
  readonly blocks: Counter;

  // open gives the last request of each crawl that has not ended, whose
  // frontier the gauges sum.
  constructor(meter: Meter, open: () => readonly CrawlRequested[]) {
    this.requests = meter.createCounter('elt.crawl.requests', {
      description: 'The requests of the crawls, by origin, lane and outcome.',
      unit: '{request}',
    });
    this.requestDuration = meter.createHistogram('elt.crawl.request.duration', {
      description:
        'The time of each HTTP exchange of the crawls, by origin, lane and outcome.',
      ...seconds,
    });
    this.requestWait = meter.createHistogram('elt.crawl.request.wait', {
      description:
        "The time that each request waited for its origin's delay and slowdown.",
      ...seconds,
    });
    this.handOffDuration = meter.createHistogram('elt.crawl.handoff.duration', {
      description:
        "The time of the crawl's consumer with each entry, such as extracting and committing a page: the crawl requests nothing meanwhile.",
      ...seconds,
    });
    this.extractDuration = meter.createHistogram('elt.web.extract.duration', {
      description: 'The time that reading and extracting each page took.',
      ...seconds,
    });
    this.committed = meter.createCounter('elt.copy.records.committed', {
      description: 'The records that the destination committed, by copy.',
      unit: '{record}',
    });
    this.blocks = meter.createCounter('elt.origin.blocks', {
      description: 'The times that an origin blocked the crawls of a read.',
      unit: '{block}',
    });
    meter
      .createObservableGauge('elt.crawl.frontier.pending', {
        description:
          "The URLs that wait in each lane of the open crawls' frontiers.",
        unit: '{url}',
      })
      .addCallback((result) => {
        const requests = open();
        for (const lane of priorities)
          result.observe(
            requests.reduce((urls, { pending }) => urls + pending[lane], 0),
            { 'elt.crawl.lane': lane },
          );
      });
    meter
      .createObservableGauge('elt.crawl.frontier.held', {
        description:
          "The URLs that a block or a spent budget holds in the open crawls' frontiers.",
        unit: '{url}',
      })
      .addCallback((result) => {
        result.observe(open().reduce((urls, { held }) => urls + held, 0));
      });
  }
}
