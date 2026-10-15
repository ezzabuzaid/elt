import type { DataPoint } from '@workspace/sdk-google-health';

import { day, fields, finite } from '../health-fields.ts';
import { PointStream } from '../point-stream.ts';

export class DailyVo2MaxStream extends PointStream {
  constructor() {
    super({
      type: 'daily-vo2-max',
      name: 'dailyVo2Max',
      named: false,
      shared: false,
      description:
        "One record per daily-vo2-max point Google Health holds for the user. Contains a daily summary of the user's VO2 max (cardio fitness score), which is the maximum rate of oxygen the body can use during exercise. Google keeps no id for these points, so the stream declares no key. Reloaded whole on every run, so a point edited or deleted upstream is replaced or gone after the next run.",
      properties: {
        cardioFitnessLevel: {
          ...fields.text,
          description:
            "Represents the user's cardio fitness level based on their VO2 max. One of POOR, FAIR, AVERAGE, GOOD, VERY_GOOD, EXCELLENT.",
        },
        ...day.properties,
        estimated: {
          ...fields.boolean,
          description:
            'An estimated field is added to indicate when the confidence has decreased sufficiently to consider the value an estimation.',
        },
        vo2Max: {
          ...fields.number,
          description:
            'Daily VO2 max value measured as in ml consumed oxygen / kg of body weight / min. Must be in the range `[0, 100]`.',
        },
        vo2MaxCovariance: {
          ...fields.number,
          description: 'The covariance of the VO2 max value.',
        },
      },
    });
  }

  protected row({ dailyVo2Max }: DataPoint) {
    return {
      cardioFitnessLevel: dailyVo2Max?.cardioFitnessLevel ?? null,
      ...day.row(dailyVo2Max?.date),
      estimated: dailyVo2Max?.estimated ?? null,
      vo2Max: finite(dailyVo2Max?.vo2Max),
      vo2MaxCovariance: finite(dailyVo2Max?.vo2MaxCovariance),
    };
  }
}
