import type { GoogleHealthStream } from './google-health-stream.ts';
import { ActiveEnergyBurnedStream } from './streams/active-energy-burned-stream.ts';
import { ActiveMinutesByActivityLevelStream } from './streams/active-minutes-by-activity-level-stream.ts';
import { ActiveMinutesStream } from './streams/active-minutes-stream.ts';
import { ActiveZoneMinutesStream } from './streams/active-zone-minutes-stream.ts';
import { ActivityLevelStream } from './streams/activity-level-stream.ts';
import { AltitudeStream } from './streams/altitude-stream.ts';
import { BasalEnergyBurnedStream } from './streams/basal-energy-burned-stream.ts';
import { BloodGlucoseStream } from './streams/blood-glucose-stream.ts';
import { BodyFatStream } from './streams/body-fat-stream.ts';
import { CaloriesInHeartRateZoneStream } from './streams/calories-in-heart-rate-zone-stream.ts';
import { CoreBodyTemperatureStream } from './streams/core-body-temperature-stream.ts';
import { DailyHeartRateVariabilityStream } from './streams/daily-heart-rate-variability-stream.ts';
import { DailyHeartRateZoneRangesStream } from './streams/daily-heart-rate-zone-ranges-stream.ts';
import { DailyHeartRateZonesStream } from './streams/daily-heart-rate-zones-stream.ts';
import { DailyOxygenSaturationStream } from './streams/daily-oxygen-saturation-stream.ts';
import { DailyRespiratoryRateStream } from './streams/daily-respiratory-rate-stream.ts';
import { DailyRestingHeartRateStream } from './streams/daily-resting-heart-rate-stream.ts';
import { DailySleepTemperatureDerivationsStream } from './streams/daily-sleep-temperature-derivations-stream.ts';
import { DailyVo2MaxStream } from './streams/daily-vo2-max-stream.ts';
import { DistanceStream } from './streams/distance-stream.ts';
import { ElectrocardiogramStream } from './streams/electrocardiogram-stream.ts';
import { ExerciseEventsStream } from './streams/exercise-events-stream.ts';
import { ExerciseRoutesStream } from './streams/exercise-routes-stream.ts';
import { ExerciseSplitSummariesStream } from './streams/exercise-split-summaries-stream.ts';
import { ExerciseSplitsStream } from './streams/exercise-splits-stream.ts';
import { ExerciseStream } from './streams/exercise-stream.ts';
import { FloorsStream } from './streams/floors-stream.ts';
import { HeartRateStream } from './streams/heart-rate-stream.ts';
import { HeartRateVariabilityStream } from './streams/heart-rate-variability-stream.ts';
import { HeightStream } from './streams/height-stream.ts';
import { HydrationLogStream } from './streams/hydration-log-stream.ts';
import { IdentityStream } from './streams/identity-stream.ts';
import { IrnProfileStream } from './streams/irn-profile-stream.ts';
import { IrregularRhythmNotificationAlertWindowsStream } from './streams/irregular-rhythm-notification-alert-windows-stream.ts';
import { IrregularRhythmNotificationHeartBeatsStream } from './streams/irregular-rhythm-notification-heart-beats-stream.ts';
import { IrregularRhythmNotificationStream } from './streams/irregular-rhythm-notification-stream.ts';
import { NutritionLogNutrientsStream } from './streams/nutrition-log-nutrients-stream.ts';
import { NutritionLogStream } from './streams/nutrition-log-stream.ts';
import { OxygenSaturationStream } from './streams/oxygen-saturation-stream.ts';
import { PairedDevicesStream } from './streams/paired-devices-stream.ts';
import { ProfileStream } from './streams/profile-stream.ts';
import { RespiratoryRateSleepSummaryStream } from './streams/respiratory-rate-sleep-summary-stream.ts';
import { RunVo2MaxStream } from './streams/run-vo2-max-stream.ts';
import { SedentaryPeriodStream } from './streams/sedentary-period-stream.ts';
import { SettingsStream } from './streams/settings-stream.ts';
import { SleepOutOfBedSegmentsStream } from './streams/sleep-out-of-bed-segments-stream.ts';
import { SleepShortAwakeningsStream } from './streams/sleep-short-awakenings-stream.ts';
import { SleepStageSummariesStream } from './streams/sleep-stage-summaries-stream.ts';
import { SleepStagesStream } from './streams/sleep-stages-stream.ts';
import { SleepStream } from './streams/sleep-stream.ts';
import { StepsStream } from './streams/steps-stream.ts';
import { SwimLengthsDataStream } from './streams/swim-lengths-data-stream.ts';
import { TimeInHeartRateZoneStream } from './streams/time-in-heart-rate-zone-stream.ts';
import { TotalCaloriesStream } from './streams/total-calories-stream.ts';
import { Vo2MaxStream } from './streams/vo2-max-stream.ts';
import { WeightStream } from './streams/weight-stream.ts';

/** Every stream the source reads: each data type, its child lists, the rollups and the account. */
export function googleHealthStreams(): GoogleHealthStream[] {
  return [
    new IdentityStream(),
    new ProfileStream(),
    new SettingsStream(),
    new IrnProfileStream(),
    new PairedDevicesStream(),
    new ActiveEnergyBurnedStream(),
    new ActiveMinutesStream(),
    new ActiveMinutesByActivityLevelStream(),
    new ActiveZoneMinutesStream(),
    new ActivityLevelStream(),
    new AltitudeStream(),
    new BasalEnergyBurnedStream(),
    new BloodGlucoseStream(),
    new BodyFatStream(),
    new CoreBodyTemperatureStream(),
    new DailyHeartRateVariabilityStream(),
    new DailyHeartRateZonesStream(),
    new DailyHeartRateZoneRangesStream(),
    new DailyOxygenSaturationStream(),
    new DailyRespiratoryRateStream(),
    new DailyRestingHeartRateStream(),
    new DailySleepTemperatureDerivationsStream(),
    new DailyVo2MaxStream(),
    new DistanceStream(),
    new ElectrocardiogramStream(),
    new ExerciseStream(),
    new ExerciseEventsStream(),
    new ExerciseSplitsStream(),
    new ExerciseSplitSummariesStream(),
    new ExerciseRoutesStream(),
    new HeartRateStream(),
    new HeartRateVariabilityStream(),
    new HeightStream(),
    new HydrationLogStream(),
    new IrregularRhythmNotificationStream(),
    new IrregularRhythmNotificationAlertWindowsStream(),
    new IrregularRhythmNotificationHeartBeatsStream(),
    new NutritionLogStream(),
    new NutritionLogNutrientsStream(),
    new OxygenSaturationStream(),
    new RespiratoryRateSleepSummaryStream(),
    new RunVo2MaxStream(),
    new SedentaryPeriodStream(),
    new SleepStream(),
    new SleepStagesStream(),
    new SleepShortAwakeningsStream(),
    new SleepOutOfBedSegmentsStream(),
    new SleepStageSummariesStream(),
    new StepsStream(),
    new SwimLengthsDataStream(),
    new TimeInHeartRateZoneStream(),
    new Vo2MaxStream(),
    new WeightStream(),
    new FloorsStream(),
    new TotalCaloriesStream(),
    new CaloriesInHeartRateZoneStream(),
  ];
}
