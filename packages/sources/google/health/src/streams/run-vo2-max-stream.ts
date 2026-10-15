import type { DataPoint } from '@workspace/sdk-google-health';

import { fields, finite, sample } from '../health-fields.ts';
import { PointStream } from '../point-stream.ts';

export class RunVo2MaxStream extends PointStream {
  constructor() {
    super({
      type: 'run-vo2-max',
      name: 'runVo2Max',
      named: false,
      shared: false,
      description:
        "One record per run-vo2-max point Google Health holds for the user. VO2 max value calculated based on the user's running activity. Value stored in ml/kg/min. Google keeps no id for these points, so the stream declares no key. Several devices can record the same moment: Apple Health relays an iPhone's and an Apple Watch's points for one walk, beside a Fitbit's, so a total over every point counts it more than once; total one device's points (deviceFormFactor, deviceDisplayName, applicationPackageName). Reloaded whole on every run, so a point edited or deleted upstream is replaced or gone after the next run.",
      properties: {
        runVo2Max: {
          ...fields.number,
          description:
            'Run VO2 max value in ml/kg/min. Must be in the range `[0, 100]`.',
        },
        ...sample.properties,
      },
    });
  }

  protected row({ runVo2Max }: DataPoint) {
    return {
      runVo2Max: finite(runVo2Max?.runVo2Max),
      ...sample.row(runVo2Max?.sampleTime),
    };
  }
}
