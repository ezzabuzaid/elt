import type { DataPoint } from '@workspace/sdk-google-health';

import { ChildStream } from '../child-stream.ts';
import { fields, session, sessionInstant } from '../health-fields.ts';
import { nameOf } from '../point-stream.ts';

export class SleepStagesStream extends ChildStream {
  constructor() {
    super({
      parent: 'sleep',
      name: 'sleepStages',
      description:
        'One record per entry in the stages list of each sleep point. Sleep stage segment. Primary key sleep and position. Reloaded whole on every run with its parent.',
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
        createTime: {
          ...fields.sessionInstant,
          description: 'Creation time of this sleep stages segment.',
        },
        type: {
          ...fields.text,
          description:
            'Sleep stage type: AWAKE, DEEP, REM, LIGHT etc. One of AWAKE, LIGHT, DEEP, REM, ASLEEP, RESTLESS.',
        },
        updateTime: {
          ...fields.sessionInstant,
          description: 'Last update time of this sleep stages segment.',
        },
      },
      primaryKey: ['sleep', 'position'],
    });
  }

  protected rows(point: DataPoint) {
    const sleep = nameOf(point);
    return (point.sleep?.stages ?? []).map((entry, position) => ({
      sleep,
      position,
      ...session.row(entry),
      createTime: sessionInstant(entry?.createTime),
      type: entry?.type ?? null,
      updateTime: sessionInstant(entry?.updateTime),
    }));
  }
}
