import type { DataPoint } from '@workspace/sdk-google-health';

import { ChildStream } from '../child-stream.ts';
import { fields } from '../health-fields.ts';
import { nameOf } from '../point-stream.ts';

export class SleepStageSummariesStream extends ChildStream {
  constructor() {
    super({
      parent: 'sleep',
      name: 'sleepStageSummaries',
      description:
        'One record per entry in the summary.stagesSummary list of each sleep point. Total duration and segment count for a stage. Primary key sleep and position. Reloaded whole on every run with its parent.',
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
        count: {
          ...fields.int64,
          description: 'Number of sleep stages segments.',
        },
        minutes: {
          ...fields.int64,
          description: 'Total duration in minutes of a sleep stage.',
        },
        type: {
          ...fields.text,
          description:
            'Sleep stage type: AWAKE, DEEP, REM, LIGHT etc. One of AWAKE, LIGHT, DEEP, REM, ASLEEP, RESTLESS.',
        },
      },
      primaryKey: ['sleep', 'position'],
    });
  }

  protected rows(point: DataPoint) {
    const sleep = nameOf(point);
    return (point.sleep?.summary?.stagesSummary ?? []).map(
      (entry, position) => ({
        sleep,
        position,
        count: entry?.count ?? null,
        minutes: entry?.minutes ?? null,
        type: entry?.type ?? null,
      }),
    );
  }
}
