import type { DataPoint } from '@workspace/sdk-google-health';

import { fields, finite, sample } from '../health-fields.ts';
import { PointStream } from '../point-stream.ts';

export class BodyFatStream extends PointStream {
  constructor() {
    super({
      type: 'body-fat',
      name: 'bodyFat',
      named: true,
      shared: false,
      description:
        "One record per body-fat point Google Health holds for the user. Body fat measurement. Primary key name, the point's resource name. Reloaded whole on every run, so a point edited or deleted upstream is replaced or gone after the next run.",
      properties: {
        percentage: {
          ...fields.number,
          description: 'Body fat percentage. Must be in the range `[0, 100]`.',
        },
        ...sample.properties,
      },
    });
  }

  protected row({ bodyFat }: DataPoint) {
    return {
      percentage: finite(bodyFat?.percentage),
      ...sample.row(bodyFat?.sampleTime),
    };
  }
}
