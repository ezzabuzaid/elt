/**
 * The data types the Google Health API v4 lets a user read, as probed live on
 * 2026-10-15. `list` returns a type's points one by one; three types answer
 * only daily rollups, each over a range of at most `maxDays` days per request.
 * A daily type gets a point for every calendar date, recorded or not
 * (`daily-heart-rate-zones` answers dates without end), so a read of one is
 * bounded by a start date. Types the API accepts only writes for (moods,
 * symptoms, menstrual periods, ovulation tests) and the public food catalog
 * (food, food measurement units) are not here.
 */
export const LISTED_DATA_TYPES = {
  'active-energy-burned': { daily: false },
  'active-minutes': { daily: false },
  'active-zone-minutes': { daily: false },
  'activity-level': { daily: false },
  altitude: { daily: false },
  'basal-energy-burned': { daily: false },
  'blood-glucose': { daily: false },
  'body-fat': { daily: false },
  'core-body-temperature': { daily: false },
  'daily-heart-rate-variability': { daily: true },
  'daily-heart-rate-zones': { daily: true },
  'daily-oxygen-saturation': { daily: true },
  'daily-respiratory-rate': { daily: true },
  'daily-resting-heart-rate': { daily: true },
  'daily-sleep-temperature-derivations': { daily: true },
  'daily-vo2-max': { daily: true },
  distance: { daily: false },
  electrocardiogram: { daily: false },
  exercise: { daily: false },
  'heart-rate': { daily: false },
  'heart-rate-variability': { daily: false },
  height: { daily: false },
  'hydration-log': { daily: false },
  'irregular-rhythm-notification': { daily: false },
  'nutrition-log': { daily: false },
  'oxygen-saturation': { daily: false },
  'respiratory-rate-sleep-summary': { daily: false },
  'run-vo2-max': { daily: false },
  'sedentary-period': { daily: false },
  sleep: { daily: false },
  steps: { daily: false },
  'swim-lengths-data': { daily: false },
  'time-in-heart-rate-zone': { daily: false },
  'vo2-max': { daily: false },
  weight: { daily: false },
} as const;

export const ROLLED_UP_DATA_TYPES = {
  'calories-in-heart-rate-zone': { maxDays: 14 },
  floors: { maxDays: 90 },
  'total-calories': { maxDays: 14 },
} as const;

export type ListedDataType = keyof typeof LISTED_DATA_TYPES;
export type RolledUpDataType = keyof typeof ROLLED_UP_DATA_TYPES;
