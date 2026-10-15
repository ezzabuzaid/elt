import type { DataPoint } from '@workspace/sdk-google-health';

import { ChildStream } from '../child-stream.ts';
import { fields, sessionInstant, sessionSample } from '../health-fields.ts';
import { pointOrigin } from '../point-stream.ts';

export class IrregularRhythmNotificationHeartBeatsStream extends ChildStream {
  constructor() {
    super({
      parent: 'irregular-rhythm-notification',
      name: 'irregularRhythmNotificationHeartBeats',
      description:
        "One record per heart beat in an analysis window of each irregular-rhythm-notification point. Its notification has no id, so each beat repeats the notification's origin and time, and the stream declares no key. Reloaded whole on every run with its notification.",
      properties: {
        ...pointOrigin.properties,
        irregularRhythmNotificationStartTime: {
          ...fields.sessionInstant,
          description: 'When the notification this beat belongs to began.',
        },
        irregularRhythmNotificationEndTime: {
          ...fields.sessionInstant,
          description: 'When the notification this beat belongs to ended.',
        },
        alertWindowPosition: {
          type: 'integer',
          minimum: 0,
          description:
            "The window's place in the notification's alertWindows list, from 0.",
        },
        position: {
          type: 'integer',
          minimum: 0,
          description: "The beat's place in its window, from 0.",
        },
        ...sessionSample.properties,
        beatsPerMinute: {
          ...fields.integer,
          description:
            'The heart rate from the gap to the next beat, 60000 divided by that gap in milliseconds.',
        },
      },
    });
  }

  protected rows(point: DataPoint) {
    const notification = point.irregularRhythmNotification;
    return (notification?.alertWindows ?? []).flatMap(
      (window, alertWindowPosition) =>
        (window.heartBeats ?? []).map((beat, position) => ({
          ...pointOrigin.row(point),
          irregularRhythmNotificationStartTime: sessionInstant(
            notification?.interval?.startTime,
          ),
          irregularRhythmNotificationEndTime: sessionInstant(
            notification?.interval?.endTime,
          ),
          alertWindowPosition,
          position,
          ...sessionSample.row(beat),
          beatsPerMinute: beat.beatsPerMinute ?? null,
        })),
    );
  }
}
