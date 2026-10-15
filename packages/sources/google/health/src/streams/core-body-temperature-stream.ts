import type { DataPoint } from '@workspace/sdk-google-health';

import { fields, finite, sample } from '../health-fields.ts';
import { PointStream } from '../point-stream.ts';

export class CoreBodyTemperatureStream extends PointStream {
  constructor() {
    super({
      type: 'core-body-temperature',
      name: 'coreBodyTemperature',
      named: true,
      shared: false,
      description:
        "One record per core-body-temperature point Google Health holds for the user. Core body temperature measurement, distinct from peripheral body temperature, reflects the temperature of the body's internal organs. Primary key name, the point's resource name. Reloaded whole on every run, so a point edited or deleted upstream is replaced or gone after the next run.",
      properties: {
        id: {
          ...fields.text,
          description:
            'The unique identifier of the core body temperature measurement.',
        },
        measurementLocation: {
          ...fields.text,
          description:
            'The location of the core body temperature measurement. One of OTHER, ARMPIT, BODY, EAR, FINGER, GASTRO_INTESTINAL, MOUTH, RECTUM, TOE, EAR_DRUM, TEMPORAL_ARTERY, FOREHEAD, URINARY_BLADDER, NASAL, NASOPHARYNGEAL, WRIST, VAGINA.',
        },
        ...sample.properties,
        temperatureCelsius: {
          ...fields.number,
          description:
            'The core body temperature in Celsius. Must be in the range `[0, 100]`.',
        },
      },
    });
  }

  protected row({ coreBodyTemperature }: DataPoint) {
    return {
      id: coreBodyTemperature?.id ?? null,
      measurementLocation: coreBodyTemperature?.measurementLocation ?? null,
      ...sample.row(coreBodyTemperature?.sampleTime),
      temperatureCelsius: finite(coreBodyTemperature?.temperatureCelsius),
    };
  }
}
