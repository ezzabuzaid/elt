import type { DataPoint } from '@workspace/sdk-google-health';

import { day, fields, finite } from '../health-fields.ts';
import { PointStream } from '../point-stream.ts';

export class DailySleepTemperatureDerivationsStream extends PointStream {
  constructor() {
    super({
      type: 'daily-sleep-temperature-derivations',
      name: 'dailySleepTemperatureDerivations',
      named: false,
      shared: false,
      description:
        'One record per daily-sleep-temperature-derivations point Google Health holds for the user. Provides derived sleep temperature values, calculated from skin or internal device temperature readings during sleep. Google keeps no id for these points, so the stream declares no key. Reloaded whole on every run, so a point edited or deleted upstream is replaced or gone after the next run.',
      properties: {
        baselineTemperatureCelsius: {
          ...fields.number,
          description:
            "The user's baseline skin temperature. It is the median of the user's nightly skin temperature over the past 30 days.",
        },
        ...day.properties,
        nightlyTemperatureCelsius: {
          ...fields.number,
          description:
            "The user's nightly skin temperature. It is the mean of skin temperature samples taken from the user’s sleep.",
        },
        relativeNightlyStddev30dCelsius: {
          ...fields.number,
          description:
            'The standard deviation of the user’s relative nightly skin temperature (temperature - baseline) over the past 30 days.',
        },
      },
    });
  }

  protected row({ dailySleepTemperatureDerivations }: DataPoint) {
    return {
      baselineTemperatureCelsius: finite(
        dailySleepTemperatureDerivations?.baselineTemperatureCelsius,
      ),
      ...day.row(dailySleepTemperatureDerivations?.date),
      nightlyTemperatureCelsius: finite(
        dailySleepTemperatureDerivations?.nightlyTemperatureCelsius,
      ),
      relativeNightlyStddev30dCelsius: finite(
        dailySleepTemperatureDerivations?.relativeNightlyStddev30dCelsius,
      ),
    };
  }
}
