import type { DataPoint } from '@workspace/sdk-google-health';

import { day, fields, finite } from '../health-fields.ts';
import { PointStream } from '../point-stream.ts';

export class DailyHeartRateVariabilityStream extends PointStream {
  constructor() {
    super({
      type: 'daily-heart-rate-variability',
      name: 'dailyHeartRateVariability',
      named: false,
      shared: false,
      description:
        'One record per daily-heart-rate-variability point Google Health holds for the user. Represents the daily heart rate variability data type. At least one of the following fields must be set: - `average_heart_rate_variability_milliseconds` - `non_rem_heart_rate_beats_per_minute` - `entropy` - `deep_sleep_root_mean_square_of_successive_differences_milliseconds` Google keeps no id for these points, so the stream declares no key. Reloaded whole on every run, so a point edited or deleted upstream is replaced or gone after the next run.',
      properties: {
        averageHeartRateVariabilityMilliseconds: {
          ...fields.number,
          description:
            "A user's average heart rate variability calculated using the root mean square of successive differences (RMSSD) in times between heartbeats.",
        },
        ...day.properties,
        deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds: {
          ...fields.number,
          description:
            'The root mean square of successive differences (RMSSD) value during deep sleep.',
        },
        entropy: {
          ...fields.number,
          description:
            'The Shanon entropy of heartbeat intervals. Entropy quantifies randomness or disorder in a system. High entropy indicates high HRV. Entropy is measured from the histogram of time interval between successive heart beats values measured during sleep.',
        },
        nonRemHeartRateBeatsPerMinute: {
          ...fields.int64,
          description: 'Non-REM heart rate',
        },
      },
    });
  }

  protected row({ dailyHeartRateVariability }: DataPoint) {
    return {
      averageHeartRateVariabilityMilliseconds: finite(
        dailyHeartRateVariability?.averageHeartRateVariabilityMilliseconds,
      ),
      ...day.row(dailyHeartRateVariability?.date),
      deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds: finite(
        dailyHeartRateVariability?.deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds,
      ),
      entropy: finite(dailyHeartRateVariability?.entropy),
      nonRemHeartRateBeatsPerMinute:
        dailyHeartRateVariability?.nonRemHeartRateBeatsPerMinute ?? null,
    };
  }
}
