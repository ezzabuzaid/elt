import type { DataPoint } from '@workspace/sdk-google-health';

import { fields, interval } from '../health-fields.ts';
import { PointStream } from '../point-stream.ts';

export class StepsStream extends PointStream {
  constructor() {
    super({
      type: 'steps',
      name: 'steps',
      named: false,
      shared: false,
      description:
        "One record per steps point Google Health holds for the user. Step count over the time interval. Google keeps no id for these points, so the stream declares no key. Several devices can record the same moment: Apple Health relays an iPhone's and an Apple Watch's points for one walk, beside a Fitbit's, so a total over every point counts it more than once; total one device's points (deviceFormFactor, deviceDisplayName, applicationPackageName). Reloaded whole on every run, so a point edited or deleted upstream is replaced or gone after the next run.",
      properties: {
        count: {
          ...fields.int64,
          description:
            'Number of steps in the recorded interval. Must be in the range `[0, 1000000]`.',
        },
        ...interval.properties,
      },
    });
  }

  protected row({ steps }: DataPoint) {
    return {
      count: steps?.count ?? null,
      ...interval.row(steps?.interval),
    };
  }
}
