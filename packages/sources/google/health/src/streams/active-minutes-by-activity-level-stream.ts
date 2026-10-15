import type { DataPoint } from '@workspace/sdk-google-health';

import { ChildStream } from '../child-stream.ts';
import { fields, instant } from '../health-fields.ts';
import { pointOrigin } from '../point-stream.ts';

export class ActiveMinutesByActivityLevelStream extends ChildStream {
  constructor() {
    super({
      parent: 'active-minutes',
      name: 'activeMinutesByActivityLevel',
      description:
        "One record per entry in the activeMinutesByActivityLevel list of each active-minutes point. Active minutes at a given activity level. Its parent has no id, so each entry repeats the parent's origin and time, and the stream declares no key. Reloaded whole on every run with its parent.",
      properties: {
        ...pointOrigin.properties,
        activeMinutesStartTime: {
          ...fields.instant,
          description:
            'When the active-minutes point this entry belongs to began.',
        },
        activeMinutesEndTime: {
          ...fields.instant,
          description:
            'When the active-minutes point this entry belongs to ended.',
        },
        position: {
          type: 'integer',
          minimum: 0,
          description: "The entry's place in the list, from 0.",
        },
        activeMinutes: {
          ...fields.int64,
          description: 'Number of whole minutes spent in activity.',
        },
        activityLevel: {
          ...fields.text,
          description:
            'The level of activity. One of LIGHT, MODERATE, VIGOROUS.',
        },
      },
    });
  }

  protected rows(point: DataPoint) {
    return (point.activeMinutes?.activeMinutesByActivityLevel ?? []).map(
      (entry, position) => ({
        ...pointOrigin.row(point),
        activeMinutesStartTime: instant(
          point.activeMinutes?.interval?.startTime,
        ),
        activeMinutesEndTime: instant(point.activeMinutes?.interval?.endTime),
        position,
        activeMinutes: entry?.activeMinutes ?? null,
        activityLevel: entry?.activityLevel ?? null,
      }),
    );
  }
}
