import type { DailyRollupDataPoint } from '@workspace/sdk-google-health';

import { calendarDate, fields, finite } from '../health-fields.ts';
import { RollupStream } from '../rollup-stream.ts';

export class CaloriesInHeartRateZoneStream extends RollupStream {
  constructor() {
    super({
      type: 'calories-in-heart-rate-zone',
      name: 'caloriesInHeartRateZone',
      description:
        'One record per day and heart rate zone of the calories burned in that zone, from the day the user joined Google Health through today. Google answers these only as daily totals; a zone the user did not reach that day is absent. Primary key date and heartRateZone. Reloaded whole on every run.',
      properties: {
        date: {
          ...fields.date,
          type: 'string',
          description: "The day, in the user's time zone.",
        },
        heartRateZone: {
          type: 'string',
          minLength: 1,
          description: 'The zone: LIGHT, MODERATE, VIGOROUS or PEAK.',
        },
        kcal: {
          ...fields.number,
          description: 'Kilocalories burned in the zone that day.',
        },
      },
      primaryKey: ['date', 'heartRateZone'],
    });
  }

  protected rows({
    civilStartTime,
    caloriesInHeartRateZone,
  }: DailyRollupDataPoint) {
    const date = calendarDate(civilStartTime?.date);
    return (caloriesInHeartRateZone?.caloriesInHeartRateZones ?? []).map(
      ({ heartRateZone, kcal }) => ({
        date,
        heartRateZone: heartRateZone ?? null,
        kcal: finite(kcal),
      }),
    );
  }
}
