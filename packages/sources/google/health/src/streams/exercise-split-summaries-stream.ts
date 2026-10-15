import type { DataPoint } from '@workspace/sdk-google-health';

import { ChildStream } from '../child-stream.ts';
import { fields, finite, seconds, session } from '../health-fields.ts';
import { nameOf } from '../point-stream.ts';

export class ExerciseSplitSummariesStream extends ChildStream {
  constructor() {
    super({
      parent: 'exercise',
      name: 'exerciseSplitSummaries',
      description:
        'One record per entry in the splitSummaries list of each exercise point. Represents splits or laps recorded within an exercise. Lap events partition a workout into segments based on criteria like distance, time, or calories. Primary key exercise and position. Reloaded whole on every run with its parent.',
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
        ...session.properties,
        activeSeconds: {
          ...fields.number,
          description: 'Lap time excluding the pauses. In seconds.',
        },
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
        splitType: {
          ...fields.text,
          description:
            'Method used to split the exercise laps. Users may manually mark the lap as complete even if the tracking is automatic. One of MANUAL, DURATION, DISTANCE, CALORIES.',
        },
      },
      primaryKey: ['exercise', 'position'],
    });
  }

  protected rows(point: DataPoint) {
    const exercise = nameOf(point);
    return (point.exercise?.splitSummaries ?? []).map((entry, position) => ({
      exercise,
      position,
      ...session.row(entry),
      activeSeconds: seconds(entry?.activeDuration),
      metricsSummaryActiveZoneMinutes:
        entry?.metricsSummary?.activeZoneMinutes ?? null,
      metricsSummaryAverageHeartRateBeatsPerMinute:
        entry?.metricsSummary?.averageHeartRateBeatsPerMinute ?? null,
      metricsSummaryAveragePaceSecondsPerMeter: finite(
        entry?.metricsSummary?.averagePaceSecondsPerMeter,
      ),
      metricsSummaryAverageSpeedMillimetersPerSecond: finite(
        entry?.metricsSummary?.averageSpeedMillimetersPerSecond,
      ),
      metricsSummaryCaloriesKcal: finite(entry?.metricsSummary?.caloriesKcal),
      metricsSummaryDistanceMillimeters: finite(
        entry?.metricsSummary?.distanceMillimeters,
      ),
      metricsSummaryElevationGainMillimeters: finite(
        entry?.metricsSummary?.elevationGainMillimeters,
      ),
      metricsSummaryHeartRateZoneDurationsLightTimeSeconds: seconds(
        entry?.metricsSummary?.heartRateZoneDurations?.lightTime,
      ),
      metricsSummaryHeartRateZoneDurationsModerateTimeSeconds: seconds(
        entry?.metricsSummary?.heartRateZoneDurations?.moderateTime,
      ),
      metricsSummaryHeartRateZoneDurationsPeakTimeSeconds: seconds(
        entry?.metricsSummary?.heartRateZoneDurations?.peakTime,
      ),
      metricsSummaryHeartRateZoneDurationsVigorousTimeSeconds: seconds(
        entry?.metricsSummary?.heartRateZoneDurations?.vigorousTime,
      ),
      metricsSummaryMobilityMetricsAvgCadenceStepsPerMinute: finite(
        entry?.metricsSummary?.mobilityMetrics?.avgCadenceStepsPerMinute,
      ),
      metricsSummaryMobilityMetricsAvgGroundContactTimeSeconds: seconds(
        entry?.metricsSummary?.mobilityMetrics?.avgGroundContactTimeDuration,
      ),
      metricsSummaryMobilityMetricsAvgStrideLengthMillimeters:
        entry?.metricsSummary?.mobilityMetrics?.avgStrideLengthMillimeters ??
        null,
      metricsSummaryMobilityMetricsAvgVerticalOscillationMillimeters:
        entry?.metricsSummary?.mobilityMetrics
          ?.avgVerticalOscillationMillimeters ?? null,
      metricsSummaryMobilityMetricsAvgVerticalRatio: finite(
        entry?.metricsSummary?.mobilityMetrics?.avgVerticalRatio,
      ),
      metricsSummaryRunVo2Max: finite(entry?.metricsSummary?.runVo2Max),
      metricsSummarySteps: entry?.metricsSummary?.steps ?? null,
      metricsSummaryTotalSwimLengths: finite(
        entry?.metricsSummary?.totalSwimLengths,
      ),
      splitType: entry?.splitType ?? null,
    }));
  }
}
