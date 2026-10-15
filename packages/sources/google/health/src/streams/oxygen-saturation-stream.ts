import type { DataPoint } from '@workspace/sdk-google-health';

import { fields, finite, sample } from '../health-fields.ts';
import { PointStream } from '../point-stream.ts';

export class OxygenSaturationStream extends PointStream {
  constructor() {
    super({
      type: 'oxygen-saturation',
      name: 'oxygenSaturation',
      named: false,
      shared: false,
      description:
        "One record per oxygen-saturation point Google Health holds for the user. Captures the user's instantaneous oxygen saturation percentage (SpO2). Google keeps no id for these points, so the stream declares no key. Several devices can record the same moment: Apple Health relays an iPhone's and an Apple Watch's points for one walk, beside a Fitbit's, so a total over every point counts it more than once; total one device's points (deviceFormFactor, deviceDisplayName, applicationPackageName). Reloaded whole on every run, so a point edited or deleted upstream is replaced or gone after the next run.",
      properties: {
        percentage: {
          ...fields.number,
          description:
            'The oxygen saturation percentage. Must be in the range `[0, 100]`.',
        },
        ...sample.properties,
      },
    });
  }

  protected row({ oxygenSaturation }: DataPoint) {
    return {
      percentage: finite(oxygenSaturation?.percentage),
      ...sample.row(oxygenSaturation?.sampleTime),
    };
  }
}
