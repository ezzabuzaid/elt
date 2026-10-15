import type { DataPoint } from '@workspace/sdk-google-health';

import { fields, finite, sample } from '../health-fields.ts';
import { PointStream } from '../point-stream.ts';

export class HeartRateVariabilityStream extends PointStream {
  constructor() {
    super({
      type: 'heart-rate-variability',
      name: 'heartRateVariability',
      named: false,
      shared: false,
      description:
        "One record per heart-rate-variability point Google Health holds for the user. Captures user's heart rate variability (HRV) as measured by the root mean square of successive differences (RMSSD) between normal heartbeats or by standard deviation of the inter-beat intervals (SDNN). Google keeps no id for these points, so the stream declares no key. Several devices can record the same moment: Apple Health relays an iPhone's and an Apple Watch's points for one walk, beside a Fitbit's, so a total over every point counts it more than once; total one device's points (deviceFormFactor, deviceDisplayName, applicationPackageName). Reloaded whole on every run, so a point edited or deleted upstream is replaced or gone after the next run.",
      properties: {
        metadataHighFrequencyPower: {
          ...fields.number,
          description:
            'The power in interbeat interval fluctuations within the high frequency band (0.15 Hz - 0.4 Hz).',
        },
        metadataLowFrequencyPower: {
          ...fields.number,
          description:
            'The power in interbeat interval fluctuations within the low frequency band (0.04 Hz - 0.15 Hz).',
        },
        rootMeanSquareOfSuccessiveDifferencesMilliseconds: {
          ...fields.number,
          description:
            'The root mean square of successive differences between normal heartbeats. This is a measure of heart rate variability used by Google Health. Must be in the range `[1, 200]`.',
        },
        ...sample.properties,
        standardDeviationMilliseconds: {
          ...fields.number,
          description:
            'The standard deviation of the heart rate variability measurement.',
        },
      },
    });
  }

  protected row({ heartRateVariability }: DataPoint) {
    return {
      metadataHighFrequencyPower: finite(
        heartRateVariability?.metadata?.highFrequencyPower,
      ),
      metadataLowFrequencyPower: finite(
        heartRateVariability?.metadata?.lowFrequencyPower,
      ),
      rootMeanSquareOfSuccessiveDifferencesMilliseconds: finite(
        heartRateVariability?.rootMeanSquareOfSuccessiveDifferencesMilliseconds,
      ),
      ...sample.row(heartRateVariability?.sampleTime),
      standardDeviationMilliseconds: finite(
        heartRateVariability?.standardDeviationMilliseconds,
      ),
    };
  }
}
