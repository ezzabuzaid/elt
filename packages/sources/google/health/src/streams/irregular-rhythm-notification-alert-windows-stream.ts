import type { DataPoint } from '@workspace/sdk-google-health';

import { ChildStream } from '../child-stream.ts';
import { fields, session, sessionInstant } from '../health-fields.ts';
import { pointOrigin } from '../point-stream.ts';

export class IrregularRhythmNotificationAlertWindowsStream extends ChildStream {
  constructor() {
    super({
      parent: 'irregular-rhythm-notification',
      name: 'irregularRhythmNotificationAlertWindows',
      description:
        'One record per entry in the alertWindows list of each irregular-rhythm-notification point. An analysis window evaluated for AFib. Note: The current version of the algorithm will only produce alerts if all windows are positive. So anything returned from the API will always have the positive bit set to true. Internally, windows can be negative, however. We never save "inconclusive" windows (they aren\'t produced by the algorithm). Its parent has no id, so each entry repeats the parent\'s origin and time, and the stream declares no key. Reloaded whole on every run with its parent.',
      properties: {
        ...pointOrigin.properties,
        irregularRhythmNotificationStartTime: {
          ...fields.sessionInstant,
          description:
            'When the irregular-rhythm-notification point this entry belongs to began.',
        },
        irregularRhythmNotificationEndTime: {
          ...fields.sessionInstant,
          description:
            'When the irregular-rhythm-notification point this entry belongs to ended.',
        },
        position: {
          type: 'integer',
          minimum: 0,
          description: "The entry's place in the list, from 0.",
        },
        ...session.properties,
        positive: {
          ...fields.boolean,
          description:
            'Flag indicating whether the window was positive for AFib or not. A `true` value indicates that AFib was detected in this window. A `false` value means AFib was not detected, but does not guarantee the absence of AFib.',
        },
      },
    });
  }

  protected rows(point: DataPoint) {
    return (point.irregularRhythmNotification?.alertWindows ?? []).map(
      (entry, position) => ({
        ...pointOrigin.row(point),
        irregularRhythmNotificationStartTime: sessionInstant(
          point.irregularRhythmNotification?.interval?.startTime,
        ),
        irregularRhythmNotificationEndTime: sessionInstant(
          point.irregularRhythmNotification?.interval?.endTime,
        ),
        position,
        ...session.row(entry),
        positive: entry?.positive ?? null,
      }),
    );
  }
}
