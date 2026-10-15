import type { DataPoint } from '@workspace/sdk-google-health';

import { day, fields, finite } from '../health-fields.ts';
import { PointStream } from '../point-stream.ts';

export class DailyOxygenSaturationStream extends PointStream {
  constructor() {
    super({
      type: 'daily-oxygen-saturation',
      name: 'dailyOxygenSaturation',
      named: false,
      shared: false,
      description:
        "One record per daily-oxygen-saturation point Google Health holds for the user. A daily oxygen saturation (SpO2) record. Represents the user's daily oxygen saturation summary, typically calculated during sleep. Google keeps no id for these points, so the stream declares no key. Reloaded whole on every run, so a point edited or deleted upstream is replaced or gone after the next run.",
      properties: {
        averagePercentage: {
          ...fields.number,
          description:
            'The average value of the oxygen saturation samples during the sleep. Must be in the range `[0, 100]`.',
        },
        ...day.properties,
        lowerBoundPercentage: {
          ...fields.number,
          description:
            'The lower bound of the confidence interval of oxygen saturation samples during sleep. Must be in the range `[0, 100]`.',
        },
        standardDeviationPercentage: {
          ...fields.number,
          description:
            'Standard deviation of the daily oxygen saturation averages from the past 7-30 days.',
        },
        upperBoundPercentage: {
          ...fields.number,
          description:
            'The upper bound of the confidence interval of oxygen saturation samples during sleep. Must be in the range `[0, 100]`.',
        },
      },
    });
  }

  protected row({ dailyOxygenSaturation }: DataPoint) {
    return {
      averagePercentage: finite(dailyOxygenSaturation?.averagePercentage),
      ...day.row(dailyOxygenSaturation?.date),
      lowerBoundPercentage: finite(dailyOxygenSaturation?.lowerBoundPercentage),
      standardDeviationPercentage: finite(
        dailyOxygenSaturation?.standardDeviationPercentage,
      ),
      upperBoundPercentage: finite(dailyOxygenSaturation?.upperBoundPercentage),
    };
  }
}
