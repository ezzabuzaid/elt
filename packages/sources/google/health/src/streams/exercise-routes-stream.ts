import type { RecordMessage } from '@workspace/elt';

import type { GoogleHealthScan } from '../google-health-scan.ts';
import { GoogleHealthStream } from '../google-health-stream.ts';
import { fields } from '../health-fields.ts';
import { nameOf } from '../point-stream.ts';

export class ExerciseRoutesStream extends GoogleHealthStream {
  constructor() {
    super({
      name: 'exerciseRoutes',
      description:
        "One record per exercise: the exercise as a TCX document, Google's export of its laps, heart rate samples and, when the exercise was tracked with GPS, its route. Primary key exercise. Reloaded whole on every run with the exercises.",
      properties: {
        exercise: {
          type: 'string',
          minLength: 1,
          description:
            'The exercise point this document belongs to: its resource name.',
        },
        tcx: {
          ...fields.text,
          description:
            'The TCX (Training Center XML) document; null when Google keeps none for the exercise.',
        },
      },
      primaryKey: ['exercise'],
    });
  }

  async *extract(
    scan: GoogleHealthScan,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<RecordMessage> {
    yield* this.records(this.#rows(scan, signal));
  }

  async *#rows(scan: GoogleHealthScan, signal: AbortSignal | undefined) {
    for (const point of await scan.shared('exercise', signal)) {
      const exercise = nameOf(point);
      const tcx = await scan.api.exerciseTcx(exercise, signal && { signal });
      yield { exercise, tcx: tcx ?? null };
    }
  }
}
