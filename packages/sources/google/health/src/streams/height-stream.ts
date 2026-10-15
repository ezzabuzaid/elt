import type { DataPoint } from '@workspace/sdk-google-health';

import { fields, sample } from '../health-fields.ts';
import { PointStream } from '../point-stream.ts';

export class HeightStream extends PointStream {
  constructor() {
    super({
      type: 'height',
      name: 'height',
      named: true,
      shared: false,
      description:
        "One record per height point Google Health holds for the user. Body height measurement. Primary key name, the point's resource name. Reloaded whole on every run, so a point edited or deleted upstream is replaced or gone after the next run.",
      properties: {
        heightMillimeters: {
          ...fields.int64,
          description:
            'Height of the user in millimeters. Must be in the range `[0, 3000]`.',
        },
        ...sample.properties,
      },
    });
  }

  protected row({ height }: DataPoint) {
    return {
      heightMillimeters: height?.heightMillimeters ?? null,
      ...sample.row(height?.sampleTime),
    };
  }
}
