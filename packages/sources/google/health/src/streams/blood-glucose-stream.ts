import type { DataPoint } from '@workspace/sdk-google-health';

import { fields, finite, sample } from '../health-fields.ts';
import { PointStream } from '../point-stream.ts';

export class BloodGlucoseStream extends PointStream {
  constructor() {
    super({
      type: 'blood-glucose',
      name: 'bloodGlucose',
      named: true,
      shared: false,
      description:
        "One record per blood-glucose point Google Health holds for the user. Represents a blood glucose level measurement. LINT: LEGACY_NAMES Primary key name, the point's resource name. Reloaded whole on every run, so a point edited or deleted upstream is replaced or gone after the next run.",
      properties: {
        bloodGlucoseMilligramsPerDeciliter: {
          ...fields.number,
          description:
            'Blood glucose level concentration in mg/dL. Must be in the range `[0, 900]`.',
        },
        mealType: {
          ...fields.text,
          description:
            'Meal type of the measurement. One of BREAKFAST, LUNCH, DINNER, SNACK.',
        },
        measurementSource: {
          ...fields.text,
          description:
            'Source of the measurement. One of SELF_MONITORING_BLOOD_GLUCOSE, CONTINUOUS_GLUCOSE_MONITORING, LAB_TEST.',
        },
        measurementTiming: {
          ...fields.text,
          description:
            'Timing of the measurement. One of AFTER_MEAL, BEFORE_MEAL, FASTING, GENERAL, BEFORE_BED, OVER_NIGHT.',
        },
        notes: {
          ...fields.text,
          description: 'Standard free-form notes captured at manual logging.',
        },
        ...sample.properties,
        specimen: {
          ...fields.text,
          description:
            'Type of body fluid used to measure the blood glucose. One of CAPILLARY_BLOOD, INTERSTITIAL_FLUID, PLASMA, SERUM, TEARS, WHOLE_BLOOD.',
        },
      },
    });
  }

  protected row({ bloodGlucose }: DataPoint) {
    return {
      bloodGlucoseMilligramsPerDeciliter: finite(
        bloodGlucose?.bloodGlucoseMilligramsPerDeciliter,
      ),
      mealType: bloodGlucose?.mealType ?? null,
      measurementSource: bloodGlucose?.measurementSource ?? null,
      measurementTiming: bloodGlucose?.measurementTiming ?? null,
      notes: bloodGlucose?.notes ?? null,
      ...sample.row(bloodGlucose?.sampleTime),
      specimen: bloodGlucose?.specimen ?? null,
    };
  }
}
