import type { DataPoint } from '@workspace/sdk-google-health';

import { ChildStream } from '../child-stream.ts';
import { fields, seconds, sessionInstant } from '../health-fields.ts';
import { nameOf } from '../point-stream.ts';

export class ExerciseEventsStream extends ChildStream {
  constructor() {
    super({
      parent: 'exercise',
      name: 'exerciseEvents',
      description:
        'One record per entry in the exerciseEvents list of each exercise point. Represents instantaneous events that happen during an exercise, such as start, stop, pause, split. Primary key exercise and position. Reloaded whole on every run with its parent.',
      properties: {
        exercise: {
          type: 'string',
          minLength: 1,
          description:
            'The exercise point this entry belongs to: its resource name.',
        },
        position: {
          type: 'integer',
          minimum: 0,
          description: "The entry's place in the list, from 0.",
        },
        eventTime: {
          ...fields.sessionInstant,
          description: 'Exercise event time',
        },
        eventUtcOffsetSeconds: {
          ...fields.number,
          description: 'Exercise event time offset from UTC In seconds.',
        },
        exerciseEventType: {
          ...fields.text,
          description:
            'The type of the event, such as start, stop, pause, resume. One of START, STOP, PAUSE, RESUME, AUTO_PAUSE, AUTO_RESUME.',
        },
      },
      primaryKey: ['exercise', 'position'],
    });
  }

  protected rows(point: DataPoint) {
    const exercise = nameOf(point);
    return (point.exercise?.exerciseEvents ?? []).map((entry, position) => ({
      exercise,
      position,
      eventTime: sessionInstant(entry?.eventTime),
      eventUtcOffsetSeconds: seconds(entry?.eventUtcOffset),
      exerciseEventType: entry?.exerciseEventType ?? null,
    }));
  }
}
