import type { DataPoint } from '@workspace/sdk-google-health';

import { fields, interval } from '../health-fields.ts';
import { PointStream } from '../point-stream.ts';

export class SwimLengthsDataStream extends PointStream {
  constructor() {
    super({
      type: 'swim-lengths-data',
      name: 'swimLengthsData',
      named: false,
      shared: false,
      description:
        "One record per swim-lengths-data point Google Health holds for the user. Swim lengths data over the time interval. Google keeps no id for these points, so the stream declares no key. Several devices can record the same moment: Apple Health relays an iPhone's and an Apple Watch's points for one walk, beside a Fitbit's, so a total over every point counts it more than once; total one device's points (deviceFormFactor, deviceDisplayName, applicationPackageName). Reloaded whole on every run, so a point edited or deleted upstream is replaced or gone after the next run.",
      properties: {
        ...interval.properties,
        strokeCount: {
          ...fields.int64,
          description: 'Number of strokes in the lap.',
        },
        swimStrokeType: {
          ...fields.text,
          description:
            'Swim stroke type. One of FREESTYLE, BACKSTROKE, BREASTSTROKE, BUTTERFLY.',
        },
      },
    });
  }

  protected row({ swimLengthsData }: DataPoint) {
    return {
      ...interval.row(swimLengthsData?.interval),
      strokeCount: swimLengthsData?.strokeCount ?? null,
      swimStrokeType: swimLengthsData?.swimStrokeType ?? null,
    };
  }
}
