import type { DataPoint } from '@workspace/sdk-google-health';

import { fields, finite, sample } from '../health-fields.ts';
import { PointStream } from '../point-stream.ts';

export class RespiratoryRateSleepSummaryStream extends PointStream {
  constructor() {
    super({
      type: 'respiratory-rate-sleep-summary',
      name: 'respiratoryRateSleepSummary',
      named: true,
      shared: false,
      description:
        "One record per respiratory-rate-sleep-summary point Google Health holds for the user. Records respiratory rate details during sleep. Can have multiple per day if the user sleeps multiple times. Primary key name, the point's resource name. Reloaded whole on every run, so a point edited or deleted upstream is replaced or gone after the next run.",
      properties: {
        deepSleepStatsBreathsPerMinute: {
          ...fields.number,
          description: 'Average breaths per minute.',
        },
        deepSleepStatsSignalToNoise: {
          ...fields.number,
          description: 'How trustworthy the data is for the computation.',
        },
        deepSleepStatsStandardDeviation: {
          ...fields.number,
          description:
            'Standard deviation of the respiratory rate during sleep.',
        },
        fullSleepStatsBreathsPerMinute: {
          ...fields.number,
          description: 'Average breaths per minute.',
        },
        fullSleepStatsSignalToNoise: {
          ...fields.number,
          description: 'How trustworthy the data is for the computation.',
        },
        fullSleepStatsStandardDeviation: {
          ...fields.number,
          description:
            'Standard deviation of the respiratory rate during sleep.',
        },
        lightSleepStatsBreathsPerMinute: {
          ...fields.number,
          description: 'Average breaths per minute.',
        },
        lightSleepStatsSignalToNoise: {
          ...fields.number,
          description: 'How trustworthy the data is for the computation.',
        },
        lightSleepStatsStandardDeviation: {
          ...fields.number,
          description:
            'Standard deviation of the respiratory rate during sleep.',
        },
        remSleepStatsBreathsPerMinute: {
          ...fields.number,
          description: 'Average breaths per minute.',
        },
        remSleepStatsSignalToNoise: {
          ...fields.number,
          description: 'How trustworthy the data is for the computation.',
        },
        remSleepStatsStandardDeviation: {
          ...fields.number,
          description:
            'Standard deviation of the respiratory rate during sleep.',
        },
        ...sample.properties,
      },
    });
  }

  protected row({ respiratoryRateSleepSummary }: DataPoint) {
    return {
      deepSleepStatsBreathsPerMinute: finite(
        respiratoryRateSleepSummary?.deepSleepStats?.breathsPerMinute,
      ),
      deepSleepStatsSignalToNoise: finite(
        respiratoryRateSleepSummary?.deepSleepStats?.signalToNoise,
      ),
      deepSleepStatsStandardDeviation: finite(
        respiratoryRateSleepSummary?.deepSleepStats?.standardDeviation,
      ),
      fullSleepStatsBreathsPerMinute: finite(
        respiratoryRateSleepSummary?.fullSleepStats?.breathsPerMinute,
      ),
      fullSleepStatsSignalToNoise: finite(
        respiratoryRateSleepSummary?.fullSleepStats?.signalToNoise,
      ),
      fullSleepStatsStandardDeviation: finite(
        respiratoryRateSleepSummary?.fullSleepStats?.standardDeviation,
      ),
      lightSleepStatsBreathsPerMinute: finite(
        respiratoryRateSleepSummary?.lightSleepStats?.breathsPerMinute,
      ),
      lightSleepStatsSignalToNoise: finite(
        respiratoryRateSleepSummary?.lightSleepStats?.signalToNoise,
      ),
      lightSleepStatsStandardDeviation: finite(
        respiratoryRateSleepSummary?.lightSleepStats?.standardDeviation,
      ),
      remSleepStatsBreathsPerMinute: finite(
        respiratoryRateSleepSummary?.remSleepStats?.breathsPerMinute,
      ),
      remSleepStatsSignalToNoise: finite(
        respiratoryRateSleepSummary?.remSleepStats?.signalToNoise,
      ),
      remSleepStatsStandardDeviation: finite(
        respiratoryRateSleepSummary?.remSleepStats?.standardDeviation,
      ),
      ...sample.row(respiratoryRateSleepSummary?.sampleTime),
    };
  }
}
