import type { DataPoint } from '@workspace/sdk-google-health';

import { interval } from '../health-fields.ts';
import { PointStream } from '../point-stream.ts';

export class ActiveMinutesStream extends PointStream {
  constructor() {
    super({
      type: 'active-minutes',
      name: 'activeMinutes',
      named: false,
      shared: true,
      description:
        "One record per active-minutes point Google Health holds for the user. Record of active minutes in a given time interval. Google keeps no id for these points, so the stream declares no key. Several devices can record the same moment: Apple Health relays an iPhone's and an Apple Watch's points for one walk, beside a Fitbit's, so a total over every point counts it more than once; total one device's points (deviceFormFactor, deviceDisplayName, applicationPackageName). Reloaded whole on every run, so a point edited or deleted upstream is replaced or gone after the next run.",
      properties: {
        ...interval.properties,
      },
    });
  }

  protected row({ activeMinutes }: DataPoint) {
    return {
      ...interval.row(activeMinutes?.interval),
    };
  }
}
