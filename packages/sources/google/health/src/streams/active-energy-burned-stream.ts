import type { DataPoint } from '@workspace/sdk-google-health';

import { fields, finite, interval } from '../health-fields.ts';
import { PointStream } from '../point-stream.ts';

export class ActiveEnergyBurnedStream extends PointStream {
  constructor() {
    super({
      type: 'active-energy-burned',
      name: 'activeEnergyBurned',
      named: false,
      shared: false,
      description:
        "One record per active-energy-burned point Google Health holds for the user. Energy burned as part of an activity, excluding the basal energy burn. Google keeps no id for these points, so the stream declares no key. Several devices can record the same moment: Apple Health relays an iPhone's and an Apple Watch's points for one walk, beside a Fitbit's, so a total over every point counts it more than once; total one device's points (deviceFormFactor, deviceDisplayName, applicationPackageName). Reloaded whole on every run, so a point edited or deleted upstream is replaced or gone after the next run.",
      properties: {
        ...interval.properties,
        kcal: {
          ...fields.number,
          description:
            'Energy burned during an activity, measured in kilocalories. Must be in the range `[0, 1000000]`.',
        },
      },
    });
  }

  protected row({ activeEnergyBurned }: DataPoint) {
    return {
      ...interval.row(activeEnergyBurned?.interval),
      kcal: finite(activeEnergyBurned?.kcal),
    };
  }
}
