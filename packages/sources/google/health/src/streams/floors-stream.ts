import type { DailyRollupDataPoint } from '@workspace/sdk-google-health';

import { calendarDate, fields } from '../health-fields.ts';
import { RollupStream } from '../rollup-stream.ts';

export class FloorsStream extends RollupStream {
  constructor() {
    super({
      type: 'floors',
      name: 'floors',
      description:
        'One record per day of floors climbed, from the day the user joined Google Health through today. Google answers floors only as daily totals; a day with nothing recorded is absent. Primary key date. Reloaded whole on every run.',
      properties: {
        date: {
          ...fields.date,
          type: 'string',
          description: "The day, in the user's time zone.",
        },
        count: { ...fields.int64, description: 'Floors climbed that day.' },
      },
      primaryKey: ['date'],
    });
  }

  protected rows({ civilStartTime, floors }: DailyRollupDataPoint) {
    return [
      {
        date: calendarDate(civilStartTime?.date),
        count: floors?.countSum ?? null,
      },
    ];
  }
}
