import type { DailyRollupDataPoint } from '@eltjs/sdk-google-health';

import { calendarDate, fields, finite } from '../health-fields.ts';
import { RollupStream } from '../rollup-stream.ts';

export class CaloriesInHeartRateZoneStream extends RollupStream {
  constructor() {
    super({
      type: 'calories-in-heart-rate-zone',
      name: 'caloriesInHeartRateZone',
      description:
        "One record per entry in the caloriesInHeartRateZones list of each day's total, the calories burned in one heart rate zone, from the day the user joined Google Health through today. Google answers these only as daily totals; a zone the user did not reach that day is absent. Google does not make a zone unique within a day's list, so the primary key is date and position. Reloaded whole on every run.",
      properties: {
        date: {
          ...fields.date,
          type: 'string',
          description: "The day, in the user's time zone.",
        },
        position: {
          type: 'integer',
          minimum: 0,
          description: "The entry's place in the day's list, from 0.",
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
      primaryKey: ['date', 'position'],
    });
  }

  protected rows({
    civilStartTime,
    caloriesInHeartRateZone,
  }: DailyRollupDataPoint) {
    const date = calendarDate(civilStartTime?.date);
    return (caloriesInHeartRateZone?.caloriesInHeartRateZones ?? []).map(
      ({ heartRateZone, kcal }, position) => ({
        date,
        position,
        heartRateZone: heartRateZone ?? null,
        kcal: finite(kcal),
      }),
    );
  }
}
