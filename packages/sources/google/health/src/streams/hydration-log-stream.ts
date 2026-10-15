import type { DataPoint } from '@workspace/sdk-google-health';

import { fields, finite, session } from '../health-fields.ts';
import { PointStream } from '../point-stream.ts';

export class HydrationLogStream extends PointStream {
  constructor() {
    super({
      type: 'hydration-log',
      name: 'hydrationLog',
      named: true,
      shared: false,
      description:
        "One record per hydration-log point Google Health holds for the user. Holds information about a user logged hydration. Primary key name, the point's resource name. Reloaded whole on every run, so a point edited or deleted upstream is replaced or gone after the next run.",
      properties: {
        amountConsumedMilliliters: {
          ...fields.number,
          description:
            'Value representing the volume in milliliters. Must be in the range `[0, 100000]`.',
        },
        amountConsumedUserProvidedUnit: {
          ...fields.text,
          description:
            'Value representing the user provided unit, used only for user-facing input and display purposes. In the API format, all volume quantities are converted to milliliters. One of CUP_IMPERIAL, CUP_US, FLUID_OUNCE_IMPERIAL, FLUID_OUNCE_US, LITER, MILLILITER, PINT_IMPERIAL, PINT_US.',
        },
        ...session.properties,
      },
    });
  }

  protected row({ hydrationLog }: DataPoint) {
    return {
      amountConsumedMilliliters: finite(
        hydrationLog?.amountConsumed?.milliliters,
      ),
      amountConsumedUserProvidedUnit:
        hydrationLog?.amountConsumed?.userProvidedUnit ?? null,
      ...session.row(hydrationLog?.interval),
    };
  }
}
