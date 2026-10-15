import type { DataPoint } from '@workspace/sdk-google-health';

import { interval } from '../health-fields.ts';
import { PointStream } from '../point-stream.ts';

export class SedentaryPeriodStream extends PointStream {
  constructor() {
    super({
      type: 'sedentary-period',
      name: 'sedentaryPeriod',
      named: false,
      shared: false,
      description:
        "One record per sedentary-period point Google Health holds for the user. SedentaryPeriod SedentaryPeriod data represents the periods of time that the user was sedentary (i.e. not moving while wearing the device). Google keeps no id for these points, so the stream declares no key. Several devices can record the same moment: Apple Health relays an iPhone's and an Apple Watch's points for one walk, beside a Fitbit's, so a total over every point counts it more than once; total one device's points (deviceFormFactor, deviceDisplayName, applicationPackageName). Reloaded whole on every run, so a point edited or deleted upstream is replaced or gone after the next run.",
      properties: {
        ...interval.properties,
      },
    });
  }

  protected row({ sedentaryPeriod }: DataPoint) {
    return {
      ...interval.row(sedentaryPeriod?.interval),
    };
  }
}
