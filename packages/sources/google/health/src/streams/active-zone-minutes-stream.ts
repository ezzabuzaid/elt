import type { DataPoint } from '@workspace/sdk-google-health';

import { fields, interval } from '../health-fields.ts';
import { PointStream } from '../point-stream.ts';

export class ActiveZoneMinutesStream extends PointStream {
  constructor() {
    super({
      type: 'active-zone-minutes',
      name: 'activeZoneMinutes',
      named: false,
      shared: false,
      description:
        "One record per active-zone-minutes point Google Health holds for the user. Record of active zone minutes in a given time interval. Google keeps no id for these points, so the stream declares no key. Several devices can record the same moment: Apple Health relays an iPhone's and an Apple Watch's points for one walk, beside a Fitbit's, so a total over every point counts it more than once; total one device's points (deviceFormFactor, deviceDisplayName, applicationPackageName). Reloaded whole on every run, so a point edited or deleted upstream is replaced or gone after the next run.",
      properties: {
        activeZoneMinutes: {
          ...fields.int64,
          description:
            'Number of Active Zone Minutes earned in the given time interval. Note: active_zone_minutes equals to 1 for low intensity (fat burn) zones or 2 for high intensity zones (cardio, peak).',
        },
        heartRateZone: {
          ...fields.text,
          description:
            'Heart rate zone in which the active zone minutes have been earned, in the given time interval. One of FAT_BURN, CARDIO, PEAK.',
        },
        ...interval.properties,
      },
    });
  }

  protected row({ activeZoneMinutes }: DataPoint) {
    return {
      activeZoneMinutes: activeZoneMinutes?.activeZoneMinutes ?? null,
      heartRateZone: activeZoneMinutes?.heartRateZone ?? null,
      ...interval.row(activeZoneMinutes?.interval),
    };
  }
}
