import type { DataPoint } from '@workspace/sdk-google-health';

import { fields, finite, interval } from '../health-fields.ts';
import { PointStream } from '../point-stream.ts';

export class BasalEnergyBurnedStream extends PointStream {
  constructor() {
    super({
      type: 'basal-energy-burned',
      name: 'basalEnergyBurned',
      named: false,
      shared: false,
      description:
        "One record per basal-energy-burned point Google Health holds for the user. Number of calories burned due to basal metabolic rate (BMR) over a period of time. Google keeps no id for these points, so the stream declares no key. Several devices can record the same moment: Apple Health relays an iPhone's and an Apple Watch's points for one walk, beside a Fitbit's, so a total over every point counts it more than once; total one device's points (deviceFormFactor, deviceDisplayName, applicationPackageName). Reloaded whole on every run, so a point edited or deleted upstream is replaced or gone after the next run.",
      properties: {
        ...interval.properties,
        kcal: {
          ...fields.number,
          description:
            'Number of calories burned due to basal metabolic rate in kilocalories over the observed interval.',
        },
      },
    });
  }

  protected row({ basalEnergyBurned }: DataPoint) {
    return {
      ...interval.row(basalEnergyBurned?.interval),
      kcal: finite(basalEnergyBurned?.kcal),
    };
  }
}
