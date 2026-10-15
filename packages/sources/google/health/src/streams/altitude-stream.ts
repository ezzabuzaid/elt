import type { DataPoint } from '@workspace/sdk-google-health';

import { fields, interval } from '../health-fields.ts';
import { PointStream } from '../point-stream.ts';

export class AltitudeStream extends PointStream {
  constructor() {
    super({
      type: 'altitude',
      name: 'altitude',
      named: false,
      shared: false,
      description:
        "One record per altitude point Google Health holds for the user. Captures the altitude gain (i.e. deltas), and not level above sea, for a user in millimeters. Google keeps no id for these points, so the stream declares no key. Several devices can record the same moment: Apple Health relays an iPhone's and an Apple Watch's points for one walk, beside a Fitbit's, so a total over every point counts it more than once; total one device's points (deviceFormFactor, deviceDisplayName, applicationPackageName). Reloaded whole on every run, so a point edited or deleted upstream is replaced or gone after the next run.",
      properties: {
        gainMillimeters: {
          ...fields.int64,
          description:
            'Altitude gain in millimeters over the observed interval. Must be in the range `[-1000000000, 1000000000]`.',
        },
        ...interval.properties,
      },
    });
  }

  protected row({ altitude }: DataPoint) {
    return {
      gainMillimeters: altitude?.gainMillimeters ?? null,
      ...interval.row(altitude?.interval),
    };
  }
}
