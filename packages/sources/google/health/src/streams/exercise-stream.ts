import type { DataPoint } from '@workspace/sdk-google-health';

import {
  fields,
  finite,
  seconds,
  session,
  sessionInstant,
} from '../health-fields.ts';
import { PointStream } from '../point-stream.ts';

export class ExerciseStream extends PointStream {
  constructor() {
    super({
      type: 'exercise',
      name: 'exercise',
      named: true,
      shared: true,
      description:
        "One record per exercise point Google Health holds for the user. An exercise that stores information about a physical activity. Primary key name, the point's resource name. Reloaded whole on every run, so a point edited or deleted upstream is replaced or gone after the next run.",
      properties: {
        activeSeconds: {
          ...fields.number,
          description: 'Duration excluding pauses. In seconds.',
        },
        createTime: {
          ...fields.sessionInstant,
          description:
            'Represents the timestamp of the creation of the exercise.',
        },
        displayName: {
          ...fields.text,
          description:
            'The localized, human-readable name of the exercise. For all exercise types other than `OTHER`, the system ignores client input and overrides this field with a generated name based on `exercise_type` (e.g., "Walking" for `WALKING`). If `exercise_type` is `OTHER`, this field can contain the user\'s custom, free-form display name.',
        },
        exerciseMetadataHasGps: {
          ...fields.boolean,
          description: 'Whether the exercise had GPS tracking.',
        },
        exerciseMetadataPoolLengthMillimeters: {
          ...fields.int64,
          description:
            'Pool length in millimeters. Only present in the swimming exercises.',
        },
        exerciseType: {
          ...fields.text,
          description:
            'The type of activity performed during an exercise. One of AEROBIC_WORKOUT, ARCHERY, ASSAULT_BIKE, BACKPACKING, BADMINTON, BALLET, BALLROOM_DANCE, BARRE_CLASS, BASEBALL, BASKETBALL, BIKING, BILLIARDS, BODY_WEIGHT, BOOTCAMP, BOWLING, BOXING, BREAKDANCING, CALISTHENICS, CANOEING, CARDIO_SCULPT, CARDIO_WORKOUT, CARPENTRY, CHEERLEADING, CIRCUIT_TRAINING, CLEANING, CLIMBING, CORE_TRAINING, CRICKET, CROQUET, CROSS_COUNTRY_SKI, CROSS_TRAINING, CROSSFIT, CURLING, DANCING, DIVING, ELECTRIC_BIKE, ELECTRIC_SCOOTER, ELLIPTICAL, EQUESTRIAN_SPORTS, EXERCISE_CLASS, FENCING, FIELD_HOCKEY, FISHING, FITNESS_GAMING, FOILING, FOOTBALL_AMERICAN, FOOTBALL_AUSTRALIAN, FREE_WEIGHTS, FRISBEE_PLAYING_GENERAL, FUNCTIONAL_STRENGTH_TRAINING, GARDENING, GOLF, GYMNASTICS, HANDBALL, HAND_CYCLING, HIIT, HIKING, HIP_HOP, HOCKEY, HOEING, HOUSEHOLD_CHORES, HUNTING, ICE_SKATING, INCLINE_RUN, INCLINE_WALK, INDOOR_CLIMBING, INTERVAL_WORKOUT, JAZZ_DANCE, JIU_JITSU, JUMPING_ROPE, KARATE, KAYAKING, KICKBOXING, KITESURFING, LACROSSE, MARTIAL_ARTS, MEDITATE, MODERN_DANCE, MOTOCROSS, MOTORCYCLE, MOUNTAIN_BIKE, MOWING_LAWN, MUAY_THAI, MULTISPORT, MUSICAL_PERFORMANCE, NORDIC_WALKING, ORIENTEERING, OTHER, OUTDOOR_BIKE, OUTDOOR_WORKOUT, PADDLEBOARDING, PADEL, PAINTING, PARAGLIDING, PARKOUR, PICKELBALL, PILATES, POLO, POWERLIFTING, POWER_WALKING, RACKET_SPORTS, RACQUETBALL, RESISTANCE_BANDS, ROCK_CLIMBING, ROLLERBLADING, ROLLER_SKATING, ROWING, ROWING_MACHINE, RUCKING, RUGBY, RUNNING, SAILING, SCOOTERING, SCUBA_DIVING, SHOOTING, SHOVELING, SKATEBOARDING, SKATING, SKIING, SKYDIVING, SNORKELING, SNOWBOARDING, SNOWMOBILING, SNOWSHOEING, SNOW_SPORT, SOCCER, SOFTBALL, SPEED_SKATING, SPINNING, SPORT, SQUASH, STAIRCLIMBER, STATIONARY_BIKE, STEP_TRAINING, STRENGTH_TRAINING, STRETCHING, STROLLER_WALK, SURFING, SWIMMING, SWIMMING_OPEN_WATER, SWIMMING_POOL, SYNCHRONIZED_SWIMMING, TABATA_WORKOUT, TABLE_TENNIS, TAEKWONDO, TAI_CHI, TANGO, TENNIS, TRACK_AND_FIELD, TRAIL_RUN, TRAMPOLINE, TREADMILL, TREADMILL_WALK, TRX, ULTIMATE_FRISBEE, UNICYCLING, VOLLEYBALL, VOLLEYBALL_BEACH, WAKEBOARDING, WALKING, WALK_WITH_WEIGHTS, WATER_AEROBICS, WATER_JOGGING, WATER_POLO, WATER_SKIING, WATER_SPORT, WATER_VOLLEYBALL, WEEDING, WEIGHTLIFTING, WEIGHT_MACHINES, WEIGHTS, WHEELCHAIR, WINDSURFING, WORKOUT, WRESTLING, YOGA, YOGA_BIKRAM, YOGA_HATHA, YOGA_POWER, YOGA_VINYASA, ZUMBA.',
        },
        ...session.properties,
        metricsSummaryActiveZoneMinutes: {
          ...fields.int64,
          description: 'Total active zone minutes for the exercise.',
        },
        metricsSummaryAverageHeartRateBeatsPerMinute: {
          ...fields.int64,
          description: 'Average heart rate during the exercise.',
        },
        metricsSummaryAveragePaceSecondsPerMeter: {
          ...fields.number,
          description: 'Average pace in seconds per meter.',
        },
        metricsSummaryAverageSpeedMillimetersPerSecond: {
          ...fields.number,
          description: 'Average speed in millimeters per second.',
        },
        metricsSummaryCaloriesKcal: {
          ...fields.number,
          description: 'Total calories burned by the user during the exercise.',
        },
        metricsSummaryDistanceMillimeters: {
          ...fields.number,
          description:
            'Total distance covered by the user during the exercise.',
        },
        metricsSummaryElevationGainMillimeters: {
          ...fields.number,
          description: 'Total elevation gain during the exercise.',
        },
        metricsSummaryHeartRateZoneDurationsLightTimeSeconds: {
          ...fields.number,
          description: 'Time spent in light heart rate zone. In seconds.',
        },
        metricsSummaryHeartRateZoneDurationsModerateTimeSeconds: {
          ...fields.number,
          description: 'Time spent in moderate heart rate zone. In seconds.',
        },
        metricsSummaryHeartRateZoneDurationsPeakTimeSeconds: {
          ...fields.number,
          description: 'Time spent in peak heart rate zone. In seconds.',
        },
        metricsSummaryHeartRateZoneDurationsVigorousTimeSeconds: {
          ...fields.number,
          description: 'Time spent in vigorous heart rate zone. In seconds.',
        },
        metricsSummaryMobilityMetricsAvgCadenceStepsPerMinute: {
          ...fields.number,
          description:
            'Cadence is a measure of the frequency of your foot strikes. Steps / min in real time during workout.',
        },
        metricsSummaryMobilityMetricsAvgGroundContactTimeSeconds: {
          ...fields.number,
          description:
            'The ground contact time for a particular stride is the amount of time for which the foot was in contact with the ground on that stride In seconds.',
        },
        metricsSummaryMobilityMetricsAvgStrideLengthMillimeters: {
          ...fields.int64,
          description:
            'Stride length is a measure of the distance covered by a single stride',
        },
        metricsSummaryMobilityMetricsAvgVerticalOscillationMillimeters: {
          ...fields.int64,
          description:
            'Distance off the ground your center of mass moves with each stride while running',
        },
        metricsSummaryMobilityMetricsAvgVerticalRatio: {
          ...fields.number,
          description:
            'Vertical oscillation/stride length between [5.0, 11.0].',
        },
        metricsSummaryRunVo2Max: {
          ...fields.number,
          description:
            'Run VO2 max value for the exercise. Only present in the running exercises at the top level as in the summary of the whole exercise.',
        },
        metricsSummarySteps: {
          ...fields.int64,
          description: 'Total steps taken during the exercise.',
        },
        metricsSummaryTotalSwimLengths: {
          ...fields.number,
          description:
            'Number of full pool lengths completed during the exercise. Only present in the swimming exercises at the top level as in the summary of the whole exercise.',
        },
        notes: {
          ...fields.text,
          description: 'Standard free-form notes captured at manual logging.',
        },
        updateTime: {
          ...fields.sessionInstant,
          description:
            'This is the timestamp of the last update to the exercise.',
        },
      },
    });
  }

  protected row({ exercise }: DataPoint) {
    return {
      activeSeconds: seconds(exercise?.activeDuration),
      createTime: sessionInstant(exercise?.createTime),
      displayName: exercise?.displayName ?? null,
      exerciseMetadataHasGps: exercise?.exerciseMetadata?.hasGps ?? null,
      exerciseMetadataPoolLengthMillimeters:
        exercise?.exerciseMetadata?.poolLengthMillimeters ?? null,
      exerciseType: exercise?.exerciseType ?? null,
      ...session.row(exercise?.interval),
      metricsSummaryActiveZoneMinutes:
        exercise?.metricsSummary?.activeZoneMinutes ?? null,
      metricsSummaryAverageHeartRateBeatsPerMinute:
        exercise?.metricsSummary?.averageHeartRateBeatsPerMinute ?? null,
      metricsSummaryAveragePaceSecondsPerMeter: finite(
        exercise?.metricsSummary?.averagePaceSecondsPerMeter,
      ),
      metricsSummaryAverageSpeedMillimetersPerSecond: finite(
        exercise?.metricsSummary?.averageSpeedMillimetersPerSecond,
      ),
      metricsSummaryCaloriesKcal: finite(
        exercise?.metricsSummary?.caloriesKcal,
      ),
      metricsSummaryDistanceMillimeters: finite(
        exercise?.metricsSummary?.distanceMillimeters,
      ),
      metricsSummaryElevationGainMillimeters: finite(
        exercise?.metricsSummary?.elevationGainMillimeters,
      ),
      metricsSummaryHeartRateZoneDurationsLightTimeSeconds: seconds(
        exercise?.metricsSummary?.heartRateZoneDurations?.lightTime,
      ),
      metricsSummaryHeartRateZoneDurationsModerateTimeSeconds: seconds(
        exercise?.metricsSummary?.heartRateZoneDurations?.moderateTime,
      ),
      metricsSummaryHeartRateZoneDurationsPeakTimeSeconds: seconds(
        exercise?.metricsSummary?.heartRateZoneDurations?.peakTime,
      ),
      metricsSummaryHeartRateZoneDurationsVigorousTimeSeconds: seconds(
        exercise?.metricsSummary?.heartRateZoneDurations?.vigorousTime,
      ),
      metricsSummaryMobilityMetricsAvgCadenceStepsPerMinute: finite(
        exercise?.metricsSummary?.mobilityMetrics?.avgCadenceStepsPerMinute,
      ),
      metricsSummaryMobilityMetricsAvgGroundContactTimeSeconds: seconds(
        exercise?.metricsSummary?.mobilityMetrics?.avgGroundContactTimeDuration,
      ),
      metricsSummaryMobilityMetricsAvgStrideLengthMillimeters:
        exercise?.metricsSummary?.mobilityMetrics?.avgStrideLengthMillimeters ??
        null,
      metricsSummaryMobilityMetricsAvgVerticalOscillationMillimeters:
        exercise?.metricsSummary?.mobilityMetrics
          ?.avgVerticalOscillationMillimeters ?? null,
      metricsSummaryMobilityMetricsAvgVerticalRatio: finite(
        exercise?.metricsSummary?.mobilityMetrics?.avgVerticalRatio,
      ),
      metricsSummaryRunVo2Max: finite(exercise?.metricsSummary?.runVo2Max),
      metricsSummarySteps: exercise?.metricsSummary?.steps ?? null,
      metricsSummaryTotalSwimLengths: finite(
        exercise?.metricsSummary?.totalSwimLengths,
      ),
      notes: exercise?.notes ?? null,
      updateTime: sessionInstant(exercise?.updateTime),
    };
  }
}
