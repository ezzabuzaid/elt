import type { DataPoint } from '@workspace/sdk-google-health';

import { fields, finite, sample } from '../health-fields.ts';
import { PointStream } from '../point-stream.ts';

export class WeightStream extends PointStream {
  constructor() {
    super({
      type: 'weight',
      name: 'weight',
      named: true,
      shared: false,
      description:
        "One record per weight point Google Health holds for the user. Body weight measurement. Primary key name, the point's resource name. Reloaded whole on every run, so a point edited or deleted upstream is replaced or gone after the next run.",
      properties: {
        notes: {
          ...fields.text,
          description: 'Standard free-form notes captured at manual logging.',
        },
        ...sample.properties,
        weightGrams: {
          ...fields.number,
          description:
            'Weight of a user in grams. Must be in the range `[0, 1000000]`.',
        },
      },
    });
  }

  protected row({ weight }: DataPoint) {
    return {
      notes: weight?.notes ?? null,
      ...sample.row(weight?.sampleTime),
      weightGrams: finite(weight?.weightGrams),
    };
  }
}
