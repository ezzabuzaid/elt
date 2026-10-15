import type { DataPoint } from '@workspace/sdk-google-health';

import { fields, interval } from '../health-fields.ts';
import { PointStream } from '../point-stream.ts';

export class TimeInHeartRateZoneStream extends PointStream {
  constructor() {
    super({
      type: 'time-in-heart-rate-zone',
      name: 'timeInHeartRateZone',
      named: false,
      shared: false,
      description:
        "One record per time-in-heart-rate-zone point Google Health holds for the user. Time in heart rate zone record. It's an interval spent in specific heart rate zone. Google keeps no id for these points, so the stream declares no key. Several devices can record the same moment: Apple Health relays an iPhone's and an Apple Watch's points for one walk, beside a Fitbit's, so a total over every point counts it more than once; total one device's points (deviceFormFactor, deviceDisplayName, applicationPackageName). Reloaded whole on every run, so a point edited or deleted upstream is replaced or gone after the next run.",
      properties: {
        heartRateZoneType: {
          ...fields.text,
          description:
            'Heart rate zone type. One of LIGHT, MODERATE, VIGOROUS, PEAK.',
        },
        ...interval.properties,
      },
    });
  }

  protected row({ timeInHeartRateZone }: DataPoint) {
    return {
      heartRateZoneType: timeInHeartRateZone?.heartRateZoneType ?? null,
      ...interval.row(timeInHeartRateZone?.interval),
    };
  }
}
