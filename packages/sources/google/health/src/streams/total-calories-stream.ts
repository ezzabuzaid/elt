import type { DailyRollupDataPoint } from '@workspace/sdk-google-health';

import { calendarDate, fields, finite } from '../health-fields.ts';
import { RollupStream } from '../rollup-stream.ts';

export class TotalCaloriesStream extends RollupStream {
  constructor() {
    super({
      type: 'total-calories',
      name: 'totalCalories',
      description:
        'One record per day of total calories burned, basal and active, from the day the user joined Google Health through today. Google answers total calories only as daily totals; a day with nothing recorded is absent. Primary key date. Reloaded whole on every run.',
      properties: {
        date: {
          ...fields.date,
          type: 'string',
          description: "The day, in the user's time zone.",
        },
        kcal: {
          ...fields.number,
          description: 'Kilocalories burned that day.',
        },
      },
      primaryKey: ['date'],
    });
  }

  protected rows({ civilStartTime, totalCalories }: DailyRollupDataPoint) {
    return [
      {
        date: calendarDate(civilStartTime?.date),
        kcal: finite(totalCalories?.kcalSum),
      },
    ];
  }
}
