import type { DataPoint } from '@workspace/sdk-google-health';

import { fields, interval } from '../health-fields.ts';
import { PointStream } from '../point-stream.ts';

export class ActivityLevelStream extends PointStream {
  constructor() {
    super({
      type: 'activity-level',
      name: 'activityLevel',
      named: false,
      shared: false,
      description:
        "One record per activity-level point Google Health holds for the user. Internal type to capture activity level during a certain time interval. Google keeps no id for these points, so the stream declares no key. Several devices can record the same moment: Apple Health relays an iPhone's and an Apple Watch's points for one walk, beside a Fitbit's, so a total over every point counts it more than once; total one device's points (deviceFormFactor, deviceDisplayName, applicationPackageName). Reloaded whole on every run, so a point edited or deleted upstream is replaced or gone after the next run.",
      properties: {
        activityLevelType: {
          ...fields.text,
          description:
            'Activity level type in the given time interval. One of SEDENTARY, LIGHTLY_ACTIVE, MODERATELY_ACTIVE, VERY_ACTIVE.',
        },
        ...interval.properties,
      },
    });
  }

  protected row({ activityLevel }: DataPoint) {
    return {
      activityLevelType: activityLevel?.activityLevelType ?? null,
      ...interval.row(activityLevel?.interval),
    };
  }
}
