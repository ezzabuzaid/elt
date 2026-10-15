// Response shapes of the Google Health API v4, typed from Google's discovery
// document (https://health.googleapis.com/$discovery/rest?version=v4,
// revision 20261014) and checked against live responses on 2026-10-15.
// Every field is optional, as proto3 JSON omits default values; enums stay
// open strings so a value Google adds later still parses; int64 values arrive
// as text, and a double that is not a finite number (Google sends NaN for a
// value it could not compute) as the string NaN, Infinity or -Infinity, read
// as that number. Food and food measurement units are left out: they are Google's
// public food catalog, not the user's data.
import { z } from 'zod';

const int64 = z.string().regex(/^-?\d+$/);
// proto3 JSON writes a double that is not a finite number as a string.
const double: z.ZodType<number, number | 'NaN' | 'Infinity' | '-Infinity'> = z
  .union([z.number(), z.enum(['NaN', 'Infinity', '-Infinity'])])
  .transform(Number);

/** Represents a whole or partial calendar date, such as a birthday. */
const date = z.object({
  day: z.number().int().optional(),
  month: z.number().int().optional(),
  year: z.number().int().optional(),
});

/** A daily oxygen saturation (SpO2) record. */
const dailyOxygenSaturation = z.object({
  averagePercentage: double.optional(),
  date: date.optional(),
  lowerBoundPercentage: double.optional(),
  standardDeviationPercentage: double.optional(),
  upperBoundPercentage: double.optional(),
});

/** Metadata for the daily resting heart rate. */
const dailyRestingHeartRateMetadata = z.object({
  calculationMethod: z.string().optional(),
});

/** Measures the daily resting heart rate for a user, calculated using the all day heart rate measurements. */
const dailyRestingHeartRate = z.object({
  beatsPerMinute: int64.optional(),
  dailyRestingHeartRateMetadata: dailyRestingHeartRateMetadata.optional(),
  date: date.optional(),
});

/** Contains a daily summary of the user's VO2 max (cardio fitness score), which is the maximum rate of oxygen the body can use during exercise. */
const dailyVO2Max = z.object({
  cardioFitnessLevel: z.string().optional(),
  date: date.optional(),
  estimated: z.boolean().optional(),
  vo2Max: double.optional(),
  vo2MaxCovariance: double.optional(),
});

/** Represents a time of day. */
const timeOfDay = z.object({
  hours: z.number().int().optional(),
  minutes: z.number().int().optional(),
  nanos: z.number().int().optional(),
  seconds: z.number().int().optional(),
});

/** Civil time representation similar to google.type.DateTime, but ensures that neither the timezone nor the UTC offset can be set to avoid confusion between civil and physical time queries. */
const civilDateTime = z.object({
  date: date.optional(),
  time: timeOfDay.optional(),
});

/** Represents a time interval of an observed data point. */
const observationTimeInterval = z.object({
  civilEndTime: civilDateTime.optional(),
  civilStartTime: civilDateTime.optional(),
  endTime: z.string().optional(),
  endUtcOffset: z.string().optional(),
  startTime: z.string().optional(),
  startUtcOffset: z.string().optional(),
});

/** Time in heart rate zone record. */
const timeInHeartRateZone = z.object({
  heartRateZoneType: z.string().optional(),
  interval: observationTimeInterval.optional(),
});

/** Number of calories burned due to basal metabolic rate (BMR) over a period of time. */
const basalEnergyBurned = z.object({
  interval: observationTimeInterval.optional(),
  kcal: double.optional(),
});

/** Represents a sample time of an observed data point. */
const observationSampleTime = z.object({
  civilTime: civilDateTime.optional(),
  physicalTime: z.string().optional(),
  utcOffset: z.string().optional(),
});

/** Core body temperature measurement, distinct from peripheral body temperature, reflects the temperature of the body's internal organs. */
const coreBodyTemperature = z.object({
  id: z.string().optional(),
  measurementLocation: z.string().optional(),
  sampleTime: observationSampleTime.optional(),
  temperatureCelsius: double.optional(),
});

/** Represents the volume quantity. */
const volumeQuantity = z.object({
  milliliters: double.optional(),
  userProvidedUnit: z.string().optional(),
});

/** Represents a time interval of session data point, which bundles multiple observed metrics together. */
const sessionTimeInterval = z.object({
  civilEndTime: civilDateTime.optional(),
  civilStartTime: civilDateTime.optional(),
  endTime: z.string().optional(),
  endUtcOffset: z.string().optional(),
  startTime: z.string().optional(),
  startUtcOffset: z.string().optional(),
});

/** Holds information about a user logged hydration. */
const hydrationLog = z.object({
  amountConsumed: volumeQuantity.optional(),
  interval: sessionTimeInterval.optional(),
});

/** Optional metadata for the application that provided this data. */
const application = z.object({
  googleWebClientId: z.string().optional(),
  packageName: z.string().optional(),
  webClientId: z.string().optional(),
});

/** Captures metadata about the device that recorded the measurement. */
const device = z.object({
  displayName: z.string().optional(),
  formFactor: z.string().optional(),
  manufacturer: z.string().optional(),
});

/** Data Source definition to track the origin of data. */
const dataSource = z.object({
  application: application.optional(),
  device: device.optional(),
  platform: z.string().optional(),
  recordingMethod: z.string().optional(),
});

/** SedentaryPeriod SedentaryPeriod data represents the periods of time that the user was sedentary (i.e. */
const sedentaryPeriod = z.object({
  interval: observationTimeInterval.optional(),
});

/** Gained elevation measured in floors over the time interval */
const floors = z.object({
  count: int64.optional(),
  interval: observationTimeInterval.optional(),
});

/** Software as Medical Device (SaMD) metadata. */
const medicalDeviceInfo = z.object({
  algorithmVersion: z.string().optional(),
  deviceModel: z.string().optional(),
  featureVersion: z.string().optional(),
  firmwareVersion: z.string().optional(),
  serviceVersion: z.string().optional(),
});

/** Represents an Electrocardiogram (ECG) measurement session. */
const electrocardiogram = z.object({
  beatsPerMinuteAvg: int64.optional(),
  interval: sessionTimeInterval.optional(),
  leadNumber: z.number().int().optional(),
  medicalDeviceInfo: medicalDeviceInfo.optional(),
  millivoltsScalingFactor: z.number().int().optional(),
  resultClassification: z.string().optional(),
  samplingFrequencyHertz: z.number().int().optional(),
  waveformSamples: z.array(z.number().int()).optional(),
});

/** Captures the altitude gain (i.e. */
const altitude = z.object({
  gainMillimeters: int64.optional(),
  interval: observationTimeInterval.optional(),
});

/** Additional exercise metadata. */
const exerciseMetadata = z.object({
  hasGps: z.boolean().optional(),
  poolLengthMillimeters: int64.optional(),
});

/** Represents instantaneous events that happen during an exercise, such as start, stop, pause, split. */
const exerciseEvent = z.object({
  eventTime: z.string().optional(),
  eventUtcOffset: z.string().optional(),
  exerciseEventType: z.string().optional(),
});

/** Mobility workouts specific metrics */
const mobilityMetrics = z.object({
  avgCadenceStepsPerMinute: double.optional(),
  avgGroundContactTimeDuration: z.string().optional(),
  avgStrideLengthMillimeters: int64.optional(),
  avgVerticalOscillationMillimeters: int64.optional(),
  avgVerticalRatio: double.optional(),
});

/** Time spent in each heart rate zone. */
const timeInHeartRateZones = z.object({
  lightTime: z.string().optional(),
  moderateTime: z.string().optional(),
  peakTime: z.string().optional(),
  vigorousTime: z.string().optional(),
});

/** Summary metrics for an exercise. */
const metricsSummary = z.object({
  activeZoneMinutes: int64.optional(),
  averageHeartRateBeatsPerMinute: int64.optional(),
  averagePaceSecondsPerMeter: double.optional(),
  averageSpeedMillimetersPerSecond: double.optional(),
  caloriesKcal: double.optional(),
  distanceMillimeters: double.optional(),
  elevationGainMillimeters: double.optional(),
  heartRateZoneDurations: timeInHeartRateZones.optional(),
  mobilityMetrics: mobilityMetrics.optional(),
  runVo2Max: double.optional(),
  steps: int64.optional(),
  totalSwimLengths: double.optional(),
});

/** Represents splits or laps recorded within an exercise. */
const splitSummary = z.object({
  activeDuration: z.string().optional(),
  endTime: z.string().optional(),
  endUtcOffset: z.string().optional(),
  metricsSummary: metricsSummary.optional(),
  splitType: z.string().optional(),
  startTime: z.string().optional(),
  startUtcOffset: z.string().optional(),
});

/** An exercise that stores information about a physical activity. */
const exercise = z.object({
  activeDuration: z.string().optional(),
  createTime: z.string().optional(),
  displayName: z.string().optional(),
  exerciseEvents: z.array(exerciseEvent).optional(),
  exerciseMetadata: exerciseMetadata.optional(),
  exerciseType: z.string().optional(),
  interval: sessionTimeInterval.optional(),
  metricsSummary: metricsSummary.optional(),
  notes: z.string().optional(),
  splits: z.array(splitSummary).optional(),
  splitSummaries: z.array(splitSummary).optional(),
  updateTime: z.string().optional(),
});

/** Represents the weight quantity. */
const weightQuantity = z.object({
  grams: double.optional(),
  userProvidedUnit: z.string().optional(),
});

/** Represents the energy quantity. */
const energyQuantity = z.object({
  kcal: double.optional(),
  userProvidedUnit: z.string().optional(),
});

/** Represents the quantity of a nutrient. */
const nutrientQuantity = z.object({
  nutrient: z.string().optional(),
  quantity: weightQuantity.optional(),
});

/** Represents different properties and information about the serving of a specific food. */
const serving = z.object({
  amount: double.optional(),
  foodMeasurementUnit: z.string().optional(),
  foodMeasurementUnitDisplayName: z.string().optional(),
});

/** Holds information about food logged by a user. */
const nutritionLog = z.object({
  energy: energyQuantity.optional(),
  energyFromFat: energyQuantity.optional(),
  food: z.string().optional(),
  foodDisplayName: z.string().optional(),
  interval: sessionTimeInterval.optional(),
  mealType: z.string().optional(),
  nutrients: z.array(nutrientQuantity).optional(),
  serving: serving.optional(),
  totalCarbohydrate: weightQuantity.optional(),
  totalFat: weightQuantity.optional(),
});

/** A single heart beat measurement. */
const heartBeat = z.object({
  beatsPerMinute: z.number().int().optional(),
  civilTime: civilDateTime.optional(),
  physicalTime: z.string().optional(),
  utcOffset: z.string().optional(),
});

/** An analysis window evaluated for AFib. */
const alertWindow = z.object({
  civilEndTime: civilDateTime.optional(),
  civilStartTime: civilDateTime.optional(),
  endTime: z.string().optional(),
  endUtcOffset: z.string().optional(),
  heartBeats: z.array(heartBeat).optional(),
  positive: z.boolean().optional(),
  startTime: z.string().optional(),
  startUtcOffset: z.string().optional(),
});

/** Represents an Irregular Rhythm Notification alert, indicating a potential sign of atrial fibrillation (AFib). */
const irregularRhythmNotification = z.object({
  alertWindows: z.array(alertWindow).optional(),
  interval: sessionTimeInterval.optional(),
  medicalDeviceInfo: medicalDeviceInfo.optional(),
});

/** The heart rate zone. */
const heartRateZone = z.object({
  heartRateZoneType: z.string().optional(),
  maxBeatsPerMinute: int64.optional(),
  minBeatsPerMinute: int64.optional(),
});

/** User's heart rate zone thresholds based on the Karvonen algorithm for a specific day. */
const dailyHeartRateZones = z.object({
  date: date.optional(),
  heartRateZones: z.array(heartRateZone).optional(),
});

/** A time interval to represent an out-of-bed segment. */
const outOfBedSegment = z.object({
  endTime: z.string().optional(),
  endUtcOffset: z.string().optional(),
  startTime: z.string().optional(),
  startUtcOffset: z.string().optional(),
});

/** Sleep stage segment. */
const sleepStage = z.object({
  createTime: z.string().optional(),
  endTime: z.string().optional(),
  endUtcOffset: z.string().optional(),
  startTime: z.string().optional(),
  startUtcOffset: z.string().optional(),
  type: z.string().optional(),
  updateTime: z.string().optional(),
});

/** Total duration and segment count for a stage. */
const stageSummary = z.object({
  count: int64.optional(),
  minutes: int64.optional(),
  type: z.string().optional(),
});

/** Sleep summary: metrics and stages summary. */
const sleepSummary = z.object({
  minutesAfterWakeUp: int64.optional(),
  minutesAsleep: int64.optional(),
  minutesAwake: int64.optional(),
  minutesInSleepPeriod: int64.optional(),
  minutesToFallAsleep: int64.optional(),
  stagesSummary: z.array(stageSummary).optional(),
});

/** Additional information about how the sleep was processed. */
const sleepMetadata = z.object({
  externalId: z.string().optional(),
  mainSleep: z.boolean().optional(),
  manuallyEdited: z.boolean().optional(),
  nap: z.boolean().optional(),
  processed: z.boolean().optional(),
  stagesStatus: z.string().optional(),
});

/** A sleep session possibly including stages. */
const sleep = z.object({
  createTime: z.string().optional(),
  interval: sessionTimeInterval.optional(),
  metadata: sleepMetadata.optional(),
  outOfBedSegments: z.array(outOfBedSegment).optional(),
  shortAwakenings: z.array(sleepStage).optional(),
  stages: z.array(sleepStage).optional(),
  summary: sleepSummary.optional(),
  type: z.string().optional(),
  updateTime: z.string().optional(),
});

/** A daily average respiratory rate (breaths per minute) for a day of the year. */
const dailyRespiratoryRate = z.object({
  breathsPerMinute: double.optional(),
  date: date.optional(),
});

/** Internal type to capture activity level during a certain time interval. */
const activityLevel = z.object({
  activityLevelType: z.string().optional(),
  interval: observationTimeInterval.optional(),
});

/** Body height measurement. */
const height = z.object({
  heightMillimeters: int64.optional(),
  sampleTime: observationSampleTime.optional(),
});

/** Represents the daily heart rate variability data type. */
const dailyHeartRateVariability = z.object({
  averageHeartRateVariabilityMilliseconds: double.optional(),
  date: date.optional(),
  deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds: double.optional(),
  entropy: double.optional(),
  nonRemHeartRateBeatsPerMinute: int64.optional(),
});

/** Ovulation test record. */
const ovulationTest = z.object({
  result: z.string().optional(),
  sampleTime: observationSampleTime.optional(),
});

/** Swim lengths data over the time interval. */
const swimLengthsData = z.object({
  interval: observationTimeInterval.optional(),
  strokeCount: int64.optional(),
  swimStrokeType: z.string().optional(),
});

/** Moods record. */
const moods = z.object({
  moods: z.array(z.string()).optional(),
  sampleTime: observationSampleTime.optional(),
  valences: z.array(z.string()).optional(),
});

/** Energy burned as part of an activity, excluding the basal energy burn. */
const activeEnergyBurned = z.object({
  interval: observationTimeInterval.optional(),
  kcal: double.optional(),
});

/** Menstrual period record. */
const menstrualPeriod = z.object({
  interval: observationTimeInterval.optional(),
  notes: z.string().optional(),
});

/** VO2 max measurement. */
const vO2Max = z.object({
  measurementMethod: z.string().optional(),
  sampleTime: observationSampleTime.optional(),
  vo2Max: double.optional(),
});

/** Represents a blood glucose level measurement. */
const bloodGlucose = z.object({
  bloodGlucoseMilligramsPerDeciliter: double.optional(),
  mealType: z.string().optional(),
  measurementSource: z.string().optional(),
  measurementTiming: z.string().optional(),
  notes: z.string().optional(),
  sampleTime: observationSampleTime.optional(),
  specimen: z.string().optional(),
});

/** Active minutes at a given activity level. */
const activeMinutesByActivityLevel = z.object({
  activeMinutes: int64.optional(),
  activityLevel: z.string().optional(),
});

/** Record of active minutes in a given time interval. */
const activeMinutes = z.object({
  activeMinutesByActivityLevel: z
    .array(activeMinutesByActivityLevel)
    .optional(),
  interval: observationTimeInterval.optional(),
});

/** Metadata for HeartRateVariability. */
const heartRateVariabilityMetadata = z.object({
  highFrequencyPower: double.optional(),
  lowFrequencyPower: double.optional(),
});

/** Captures user's heart rate variability (HRV) as measured by the root mean square of successive differences (RMSSD) between normal heartbeats or by standard deviation of the inter-beat intervals (SDNN). */
const heartRateVariability = z.object({
  metadata: heartRateVariabilityMetadata.optional(),
  rootMeanSquareOfSuccessiveDifferencesMilliseconds: double.optional(),
  sampleTime: observationSampleTime.optional(),
  standardDeviationMilliseconds: double.optional(),
});

/** Body fat measurement. */
const bodyFat = z.object({
  percentage: double.optional(),
  sampleTime: observationSampleTime.optional(),
});

/** VO2 max value calculated based on the user's running activity. */
const runVO2Max = z.object({
  runVo2Max: double.optional(),
  sampleTime: observationSampleTime.optional(),
});

/** Respiratory rate statistics for a given sleep stage. */
const respiratoryRateSleepSummaryStatistics = z.object({
  breathsPerMinute: double.optional(),
  signalToNoise: double.optional(),
  standardDeviation: double.optional(),
});

/** Records respiratory rate details during sleep. */
const respiratoryRateSleepSummary = z.object({
  deepSleepStats: respiratoryRateSleepSummaryStatistics.optional(),
  fullSleepStats: respiratoryRateSleepSummaryStatistics.optional(),
  lightSleepStats: respiratoryRateSleepSummaryStatistics.optional(),
  remSleepStats: respiratoryRateSleepSummaryStatistics.optional(),
  sampleTime: observationSampleTime.optional(),
});

/** Distance traveled over an interval of time. */
const distance = z.object({
  interval: observationTimeInterval.optional(),
  millimeters: int64.optional(),
});

/** Heart rate metadata. */
const heartRateMetadata = z.object({
  motionContext: z.string().optional(),
  sensorLocation: z.string().optional(),
});

/** A heart rate measurement. */
const heartRate = z.object({
  beatsPerMinute: int64.optional(),
  metadata: heartRateMetadata.optional(),
  sampleTime: observationSampleTime.optional(),
});

/** Record of active zone minutes in a given time interval. */
const activeZoneMinutes = z.object({
  activeZoneMinutes: int64.optional(),
  heartRateZone: z.string().optional(),
  interval: observationTimeInterval.optional(),
});

/** Body weight measurement. */
const weight = z.object({
  notes: z.string().optional(),
  sampleTime: observationSampleTime.optional(),
  weightGrams: double.optional(),
});

/** Step count over the time interval. */
const steps = z.object({
  count: int64.optional(),
  interval: observationTimeInterval.optional(),
});

/** Provides derived sleep temperature values, calculated from skin or internal device temperature readings during sleep. */
const dailySleepTemperatureDerivations = z.object({
  baselineTemperatureCelsius: double.optional(),
  date: date.optional(),
  nightlyTemperatureCelsius: double.optional(),
  relativeNightlyStddev30dCelsius: double.optional(),
});

/** Captures the user's instantaneous oxygen saturation percentage (SpO2). */
const oxygenSaturation = z.object({
  percentage: double.optional(),
  sampleTime: observationSampleTime.optional(),
});

/** Symptoms logged by the user. */
const symptoms = z.object({
  sampleTime: observationSampleTime.optional(),
  symptoms: z.array(z.string()).optional(),
});

/** A computed or recorded metric. */
const dataPoint = z.object({
  activeEnergyBurned: activeEnergyBurned.optional(),
  activeMinutes: activeMinutes.optional(),
  activeZoneMinutes: activeZoneMinutes.optional(),
  activityLevel: activityLevel.optional(),
  altitude: altitude.optional(),
  basalEnergyBurned: basalEnergyBurned.optional(),
  bloodGlucose: bloodGlucose.optional(),
  bodyFat: bodyFat.optional(),
  coreBodyTemperature: coreBodyTemperature.optional(),
  dailyHeartRateVariability: dailyHeartRateVariability.optional(),
  dailyHeartRateZones: dailyHeartRateZones.optional(),
  dailyOxygenSaturation: dailyOxygenSaturation.optional(),
  dailyRespiratoryRate: dailyRespiratoryRate.optional(),
  dailyRestingHeartRate: dailyRestingHeartRate.optional(),
  dailySleepTemperatureDerivations: dailySleepTemperatureDerivations.optional(),
  dailyVo2Max: dailyVO2Max.optional(),
  dataSource: dataSource.optional(),
  distance: distance.optional(),
  electrocardiogram: electrocardiogram.optional(),
  exercise: exercise.optional(),
  floors: floors.optional(),
  heartRate: heartRate.optional(),
  heartRateVariability: heartRateVariability.optional(),
  height: height.optional(),
  hydrationLog: hydrationLog.optional(),
  irregularRhythmNotification: irregularRhythmNotification.optional(),
  menstrualPeriod: menstrualPeriod.optional(),
  moods: moods.optional(),
  name: z.string().optional(),
  nutritionLog: nutritionLog.optional(),
  ovulationTest: ovulationTest.optional(),
  oxygenSaturation: oxygenSaturation.optional(),
  respiratoryRateSleepSummary: respiratoryRateSleepSummary.optional(),
  runVo2Max: runVO2Max.optional(),
  sedentaryPeriod: sedentaryPeriod.optional(),
  sleep: sleep.optional(),
  steps: steps.optional(),
  swimLengthsData: swimLengthsData.optional(),
  symptoms: symptoms.optional(),
  timeInHeartRateZone: timeInHeartRateZone.optional(),
  vo2Max: vO2Max.optional(),
  weight: weight.optional(),
});

/** Response containing raw data points matching the query */
export const listDataPointsResponse = z.object({
  dataPoints: z.array(dataPoint).optional(),
  nextPageToken: z.string().optional(),
});

/** Represents the result of the rollup of the user's sedentary periods. */
const sedentaryPeriodRollupValue = z.object({
  durationSum: z.string().optional(),
});

/** Represents the result of the rollup of the blood glucose data type. */
const bloodGlucoseRollupValue = z.object({
  bloodGlucoseMilligramsPerDeciliterAvg: double.optional(),
});

/** Represents the rollup value for the daily resting heart rate data type. */
const restingHeartRatePersonalRangeRollupValue = z.object({
  beatsPerMinuteMax: double.optional(),
  beatsPerMinuteMin: double.optional(),
});

/** Represents the result of the rollup of the user's altitude. */
const altitudeRollupValue = z.object({
  gainMillimetersSum: int64.optional(),
});

/** Represents the result of the rollup of the core body temperature data type. */
const coreBodyTemperatureRollupValue = z.object({
  temperatureCelsiusAvg: double.optional(),
  temperatureCelsiusMax: double.optional(),
  temperatureCelsiusMin: double.optional(),
});

/** Represents the total time spent in a specific heart rate zone. */
const timeInHeartRateZoneValue = z.object({
  duration: z.string().optional(),
  heartRateZone: z.string().optional(),
});

/** Represents the result of the rollup of the time in heart rate zone data type. */
const timeInHeartRateZoneRollupValue = z.object({
  timeInHeartRateZones: z.array(timeInHeartRateZoneValue).optional(),
});

/** Represents the result of the rollup of the user's total calories. */
const totalCaloriesRollupValue = z.object({
  kcalSum: double.optional(),
});

/** Represents the result of the rollup of the user's floors. */
const floorsRollupValue = z.object({
  countSum: int64.optional(),
});

/** Active minutes by activity level. */
const activeMinutesRollupByActivityLevel = z.object({
  activeMinutesSum: int64.optional(),
  activityLevel: z.string().optional(),
});

/** Represents the result of the rollup of the active minutes data type. */
const activeMinutesRollupValue = z.object({
  activeMinutesRollupByActivityLevel: z
    .array(activeMinutesRollupByActivityLevel)
    .optional(),
});

/** Rollup for volume quantity. */
const volumeQuantityRollup = z.object({
  millilitersSum: double.optional(),
  userProvidedUnitLast: z.string().optional(),
});

/** Represents the result of the rollup of the hydration log data type. */
const hydrationLogRollupValue = z.object({
  amountConsumed: volumeQuantityRollup.optional(),
});

/** Represents the amount of kilocalories burned in a specific heart rate zone. */
const caloriesInHeartRateZoneValue = z.object({
  heartRateZone: z.string().optional(),
  kcal: double.optional(),
});

/** Represents the result of the rollup of the calories in heart rate zone data type. */
const caloriesInHeartRateZoneRollupValue = z.object({
  caloriesInHeartRateZones: z.array(caloriesInHeartRateZoneValue).optional(),
});

/** Represents the result of the rollup of the user's daily heart rate variability personal range. */
const heartRateVariabilityPersonalRangeRollupValue = z.object({
  averageHeartRateVariabilityMillisecondsMax: double.optional(),
  averageHeartRateVariabilityMillisecondsMin: double.optional(),
});

/** Represents the result of the rollup of the steps data type. */
const stepsRollupValue = z.object({
  countSum: int64.optional(),
});

/** Represents the result of the rollup of the weight data type. */
const weightRollupValue = z.object({
  weightGramsAvg: double.optional(),
});

/** Represents the result of the rollup of the swim lengths data type. */
const swimLengthsDataRollupValue = z.object({
  strokeCountSum: int64.optional(),
});

/** Represents the result of the rollup of the body fat data type. */
const bodyFatRollupValue = z.object({
  bodyFatPercentageAvg: double.optional(),
});

/** Represents the total duration in a specific activity level type. */
const activityLevelRollupByActivityLevelType = z.object({
  activityLevelType: z.string().optional(),
  totalDuration: z.string().optional(),
});

/** Represents the result of the rollup of the activity level data type. */
const activityLevelRollupValue = z.object({
  activityLevelRollupsByActivityLevelType: z
    .array(activityLevelRollupByActivityLevelType)
    .optional(),
});

/** Represents the result of the rollup of the active zone minutes data type. */
const activeZoneMinutesRollupValue = z.object({
  sumInCardioHeartZone: int64.optional(),
  sumInFatBurnHeartZone: int64.optional(),
  sumInPeakHeartZone: int64.optional(),
});

/** Represents the result of the rollup of active energy burned. */
const activeEnergyBurnedRollupValue = z.object({
  kcalSum: double.optional(),
});

/** Result of the rollup of the user's distance. */
const distanceRollupValue = z.object({
  millimetersSum: int64.optional(),
});

/** Represents the result of the rollup of the user's daily heart rate variability personal range. */
const runVO2MaxRollupValue = z.object({
  rateAvg: double.optional(),
  rateMax: double.optional(),
  rateMin: double.optional(),
});

/** Represents the result of the rollup of the heart rate data type. */
const heartRateRollupValue = z.object({
  beatsPerMinuteAvg: double.optional(),
  beatsPerMinuteMax: double.optional(),
  beatsPerMinuteMin: double.optional(),
});

/** Rollup for the weight. */
const weightQuantityRollup = z.object({
  gramsSum: double.optional(),
  userProvidedUnitLast: z.string().optional(),
});

/** Nutrient quantity rollup. */
const nutrientQuantityRollup = z.object({
  nutrient: z.string().optional(),
  quantity: weightQuantityRollup.optional(),
});

/** Rollup for the energy quantity. */
const energyQuantityRollup = z.object({
  kcalSum: double.optional(),
  userProvidedUnitLast: z.string().optional(),
});

/** Represents the result of the rollup of the nutrition log data type. */
const nutritionLogRollupValue = z.object({
  energy: energyQuantityRollup.optional(),
  energyFromFat: energyQuantityRollup.optional(),
  nutrients: z.array(nutrientQuantityRollup).optional(),
  totalCarbohydrate: weightQuantityRollup.optional(),
  totalFat: weightQuantityRollup.optional(),
});

/** Value of a daily rollup for a single civil time interval (aggregation window) of reconciled data points from all data sources, excluding those data points that are identified as recorded by wearables in intervals when they were not actually worn. */
const dailyRollupDataPoint = z.object({
  activeEnergyBurned: activeEnergyBurnedRollupValue.optional(),
  activeMinutes: activeMinutesRollupValue.optional(),
  activeZoneMinutes: activeZoneMinutesRollupValue.optional(),
  activityLevel: activityLevelRollupValue.optional(),
  altitude: altitudeRollupValue.optional(),
  bloodGlucose: bloodGlucoseRollupValue.optional(),
  bodyFat: bodyFatRollupValue.optional(),
  caloriesInHeartRateZone: caloriesInHeartRateZoneRollupValue.optional(),
  civilEndTime: civilDateTime.optional(),
  civilStartTime: civilDateTime.optional(),
  coreBodyTemperature: coreBodyTemperatureRollupValue.optional(),
  distance: distanceRollupValue.optional(),
  floors: floorsRollupValue.optional(),
  heartRate: heartRateRollupValue.optional(),
  heartRateVariabilityPersonalRange:
    heartRateVariabilityPersonalRangeRollupValue.optional(),
  hydrationLog: hydrationLogRollupValue.optional(),
  nutritionLog: nutritionLogRollupValue.optional(),
  restingHeartRatePersonalRange:
    restingHeartRatePersonalRangeRollupValue.optional(),
  runVo2Max: runVO2MaxRollupValue.optional(),
  sedentaryPeriod: sedentaryPeriodRollupValue.optional(),
  steps: stepsRollupValue.optional(),
  swimLengthsData: swimLengthsDataRollupValue.optional(),
  timeInHeartRateZone: timeInHeartRateZoneRollupValue.optional(),
  totalCalories: totalCaloriesRollupValue.optional(),
  weight: weightRollupValue.optional(),
});

/** Response containing the list of rolled up data points. */
export const dailyRollUpDataPointsResponse = z.object({
  nextPageToken: z.string().optional(),
  rollupDataPoints: z.array(dailyRollupDataPoint).optional(),
});

/** Represents details about the Google user's identity. */
export const identity = z.object({
  healthUserId: z.string().optional(),
  legacyUserId: z.string().optional(),
  name: z.string().optional(),
});

/** Profile details. */
export const profile = z.object({
  age: z.number().int().optional(),
  autoRunningStrideLengthMm: z.number().int().optional(),
  autoWalkingStrideLengthMm: z.number().int().optional(),
  membershipStartDate: date.optional(),
  name: z.string().optional(),
  userConfiguredRunningStrideLengthMm: z.number().int().optional(),
  userConfiguredWalkingStrideLengthMm: z.number().int().optional(),
});

/** Settings details. */
export const settings = z.object({
  autoStrideEnabled: z.boolean().optional(),
  distanceUnit: z.string().optional(),
  foodLanguageCode: z.string().optional(),
  glucoseUnit: z.string().optional(),
  heightUnit: z.string().optional(),
  languageLocale: z.string().optional(),
  name: z.string().optional(),
  strideLengthRunningType: z.string().optional(),
  strideLengthWalkingType: z.string().optional(),
  swimUnit: z.string().optional(),
  temperatureUnit: z.string().optional(),
  timeZone: z.string().optional(),
  utcOffset: z.string().optional(),
  waterUnit: z.string().optional(),
  weightUnit: z.string().optional(),
});

/** Irregular Rhythm Notifications (IRN) Profile details. */
export const irnProfile = z.object({
  enrollmentStatus: z.boolean().optional(),
  name: z.string().optional(),
  onboardingStatus: z.boolean().optional(),
  updateTime: z.string().optional(),
});

/** User's Paired 1P Device The PairedDevice details include information about the device type, battery status, battery level, last sync time, device version, mac address, and features. */
const pairedDevice = z.object({
  batteryLevel: z.number().int().optional(),
  batteryStatus: z.string().optional(),
  deviceType: z.string().optional(),
  deviceVersion: z.string().optional(),
  features: z.array(z.string()).optional(),
  lastSyncTime: z.string().optional(),
  macAddress: z.string().optional(),
  name: z.string().optional(),
});

/** Response message for ListPairedDevices. */
export const listPairedDevicesResponse = z.object({
  nextPageToken: z.string().optional(),
  pairedDevices: z.array(pairedDevice).optional(),
});

/** Represents a Response for exporting exercise data in TCX format. */
export const exportExerciseTcxResponse = z.object({
  tcxData: z.string().optional(),
});

export type DataPoint = z.infer<typeof dataPoint>;
export type ListDataPointsResponse = z.infer<typeof listDataPointsResponse>;
export type DailyRollupDataPoint = z.infer<typeof dailyRollupDataPoint>;
export type DailyRollUpDataPointsResponse = z.infer<
  typeof dailyRollUpDataPointsResponse
>;
export type Identity = z.infer<typeof identity>;
export type Profile = z.infer<typeof profile>;
export type Settings = z.infer<typeof settings>;
export type IrnProfile = z.infer<typeof irnProfile>;
export type PairedDevice = z.infer<typeof pairedDevice>;
export type ListPairedDevicesResponse = z.infer<
  typeof listPairedDevicesResponse
>;
export type ExportExerciseTcxResponse = z.infer<
  typeof exportExerciseTcxResponse
>;
