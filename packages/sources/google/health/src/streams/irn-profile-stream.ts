import { AccountStream } from '../account-stream.ts';
import type { GoogleHealthScan } from '../google-health-scan.ts';
import { fields, instant } from '../health-fields.ts';

export class IrnProfileStream extends AccountStream {
  constructor() {
    super({
      name: 'irnProfile',
      description:
        "One record: the user's enrollment in Irregular Rhythm Notifications, the alerts for signs of atrial fibrillation. Reloaded whole on every run.",
      properties: {
        enrollmentStatus: {
          ...fields.boolean,
          description: "Whether the user's data is analyzed for IRN alerts.",
        },
        onboardingStatus: {
          ...fields.boolean,
          description: 'Whether the user has been onboarded to IRN.',
        },
        updateTime: {
          ...fields.instant,
          description: 'When the user last synced data IRN can analyze.',
        },
      },
    });
  }

  protected async rows(
    scan: GoogleHealthScan,
    signal: AbortSignal | undefined,
  ) {
    const irn = await scan.api.irnProfile(signal && { signal });
    return [
      {
        enrollmentStatus: irn.enrollmentStatus ?? null,
        onboardingStatus: irn.onboardingStatus ?? null,
        updateTime: instant(irn.updateTime),
      },
    ];
  }
}
