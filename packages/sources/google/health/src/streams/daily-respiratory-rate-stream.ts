import type { DataPoint } from '@workspace/sdk-google-health';

import { day, fields, finite } from '../health-fields.ts';
import { PointStream } from '../point-stream.ts';

export class DailyRespiratoryRateStream extends PointStream {
  constructor() {
    super({
      type: 'daily-respiratory-rate',
      name: 'dailyRespiratoryRate',
      named: false,
      shared: false,
      description:
        'One record per daily-respiratory-rate point Google Health holds for the user. A daily average respiratory rate (breaths per minute) for a day of the year. One data point per day calculated for the main sleep. Google keeps no id for these points, so the stream declares no key. Reloaded whole on every run, so a point edited or deleted upstream is replaced or gone after the next run.',
      properties: {
        breathsPerMinute: {
          ...fields.number,
          description: 'The average number of breaths taken per minute.',
        },
        ...day.properties,
      },
    });
  }

  protected row({ dailyRespiratoryRate }: DataPoint) {
    return {
      breathsPerMinute: finite(dailyRespiratoryRate?.breathsPerMinute),
      ...day.row(dailyRespiratoryRate?.date),
    };
  }
}
