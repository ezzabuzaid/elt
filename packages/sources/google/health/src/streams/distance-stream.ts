import type { DataPoint } from '@workspace/sdk-google-health';

import { fields, interval } from '../health-fields.ts';
import { PointStream } from '../point-stream.ts';

export class DistanceStream extends PointStream {
  constructor() {
    super({
      type: 'distance',
      name: 'distance',
      named: false,
      shared: false,
      description:
        "One record per distance point Google Health holds for the user. Distance traveled over an interval of time. Google keeps no id for these points, so the stream declares no key. Several devices can record the same moment: Apple Health relays an iPhone's and an Apple Watch's points for one walk, beside a Fitbit's, so a total over every point counts it more than once; total one device's points (deviceFormFactor, deviceDisplayName, applicationPackageName). Reloaded whole on every run, so a point edited or deleted upstream is replaced or gone after the next run.",
      properties: {
        ...interval.properties,
        millimeters: {
          ...fields.int64,
          description:
            'Distance in millimeters over the observed interval. Must be in the range `[0, 1000000000]`.',
        },
      },
    });
  }

  protected row({ distance }: DataPoint) {
    return {
      ...interval.row(distance?.interval),
      millimeters: distance?.millimeters ?? null,
    };
  }
}
