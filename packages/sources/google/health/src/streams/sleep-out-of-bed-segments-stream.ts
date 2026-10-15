import type { DataPoint } from '@workspace/sdk-google-health';

import { ChildStream } from '../child-stream.ts';
import { session } from '../health-fields.ts';
import { nameOf } from '../point-stream.ts';

export class SleepOutOfBedSegmentsStream extends ChildStream {
  constructor() {
    super({
      parent: 'sleep',
      name: 'sleepOutOfBedSegments',
      description:
        'One record per entry in the outOfBedSegments list of each sleep point. A time interval to represent an out-of-bed segment. Primary key sleep and position. Reloaded whole on every run with its parent.',
      properties: {
        sleep: {
          type: 'string',
          minLength: 1,
          description:
            'The sleep point this entry belongs to: its resource name.',
        },
        position: {
          type: 'integer',
          minimum: 0,
          description: "The entry's place in the list, from 0.",
        },
        ...session.properties,
      },
      primaryKey: ['sleep', 'position'],
    });
  }

  protected rows(point: DataPoint) {
    const sleep = nameOf(point);
    return (point.sleep?.outOfBedSegments ?? []).map((entry, position) => ({
      sleep,
      position,
      ...session.row(entry),
    }));
  }
}
