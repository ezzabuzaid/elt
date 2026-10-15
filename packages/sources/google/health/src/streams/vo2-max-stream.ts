import type { DataPoint } from '@workspace/sdk-google-health';

import { fields, finite, sample } from '../health-fields.ts';
import { PointStream } from '../point-stream.ts';

export class Vo2MaxStream extends PointStream {
  constructor() {
    super({
      type: 'vo2-max',
      name: 'vo2Max',
      named: false,
      shared: false,
      description:
        "One record per vo2-max point Google Health holds for the user. VO2 max measurement. Google keeps no id for these points, so the stream declares no key. Several devices can record the same moment: Apple Health relays an iPhone's and an Apple Watch's points for one walk, beside a Fitbit's, so a total over every point counts it more than once; total one device's points (deviceFormFactor, deviceDisplayName, applicationPackageName). Reloaded whole on every run, so a point edited or deleted upstream is replaced or gone after the next run.",
      properties: {
        measurementMethod: {
          ...fields.text,
          description:
            'The method used to measure the VO2 max value. One of FITBIT_RUN, GOOGLE_DEMOGRAPHIC, COOPER_TEST, HEART_RATE_RATIO, METABOLIC_CART, MULTISTAGE_FITNESS_TEST, ROCKPORT_FITNESS_TEST, MAX_EXERCISE, PREDICTION_SUB_MAX_EXERCISE, PREDICTION_NON_EXERCISE, OTHER.',
        },
        ...sample.properties,
        vo2Max: {
          ...fields.number,
          description:
            'VO2 max value measured as in ml consumed oxygen / kg of body weight / min. Must be in the range `[0, 100]`.',
        },
      },
    });
  }

  protected row({ vo2Max }: DataPoint) {
    return {
      measurementMethod: vo2Max?.measurementMethod ?? null,
      ...sample.row(vo2Max?.sampleTime),
      vo2Max: finite(vo2Max?.vo2Max),
    };
  }
}
