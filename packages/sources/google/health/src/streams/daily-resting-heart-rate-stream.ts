import type { DataPoint } from '@workspace/sdk-google-health';

import { day, fields } from '../health-fields.ts';
import { PointStream } from '../point-stream.ts';

export class DailyRestingHeartRateStream extends PointStream {
  constructor() {
    super({
      type: 'daily-resting-heart-rate',
      name: 'dailyRestingHeartRate',
      named: false,
      shared: false,
      description:
        'One record per daily-resting-heart-rate point Google Health holds for the user. Measures the daily resting heart rate for a user, calculated using the all day heart rate measurements. Google keeps no id for these points, so the stream declares no key. Reloaded whole on every run, so a point edited or deleted upstream is replaced or gone after the next run.',
      properties: {
        beatsPerMinute: {
          ...fields.int64,
          description: 'The resting heart rate value in beats per minute.',
        },
        dailyRestingHeartRateMetadataCalculationMethod: {
          ...fields.text,
          description:
            'The method used to calculate the resting heart rate. One of WITH_SLEEP, ONLY_WITH_AWAKE_DATA.',
        },
        ...day.properties,
      },
    });
  }

  protected row({ dailyRestingHeartRate }: DataPoint) {
    return {
      beatsPerMinute: dailyRestingHeartRate?.beatsPerMinute ?? null,
      dailyRestingHeartRateMetadataCalculationMethod:
        dailyRestingHeartRate?.dailyRestingHeartRateMetadata
          ?.calculationMethod ?? null,
      ...day.row(dailyRestingHeartRate?.date),
    };
  }
}
