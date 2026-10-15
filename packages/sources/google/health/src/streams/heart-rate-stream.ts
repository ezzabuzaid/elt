import type { DataPoint } from '@workspace/sdk-google-health';

import { fields, sample } from '../health-fields.ts';
import { PointStream } from '../point-stream.ts';

export class HeartRateStream extends PointStream {
  constructor() {
    super({
      type: 'heart-rate',
      name: 'heartRate',
      named: false,
      shared: false,
      description:
        "One record per heart-rate point Google Health holds for the user. A heart rate measurement. Google keeps no id for these points, so the stream declares no key. Several devices can record the same moment: Apple Health relays an iPhone's and an Apple Watch's points for one walk, beside a Fitbit's, so a total over every point counts it more than once; total one device's points (deviceFormFactor, deviceDisplayName, applicationPackageName). Reloaded whole on every run, so a point edited or deleted upstream is replaced or gone after the next run.",
      properties: {
        beatsPerMinute: {
          ...fields.int64,
          description:
            'The heart rate value in beats per minute. Must be in the range `[1, 300]`.',
        },
        metadataMotionContext: {
          ...fields.text,
          description:
            'Indicates the user’s level of activity when the heart rate sample was measured One of ACTIVE, SEDENTARY.',
        },
        metadataSensorLocation: {
          ...fields.text,
          description:
            'Indicates the location of the sensor that measured the heart rate. One of CHEST, WRIST, FINGER, HAND, EAR_LOBE, FOOT.',
        },
        ...sample.properties,
      },
    });
  }

  protected row({ heartRate }: DataPoint) {
    return {
      beatsPerMinute: heartRate?.beatsPerMinute ?? null,
      metadataMotionContext: heartRate?.metadata?.motionContext ?? null,
      metadataSensorLocation: heartRate?.metadata?.sensorLocation ?? null,
      ...sample.row(heartRate?.sampleTime),
    };
  }
}
