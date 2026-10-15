import { AccountStream } from '../account-stream.ts';
import type { GoogleHealthScan } from '../google-health-scan.ts';
import { fields } from '../health-fields.ts';

export class IdentityStream extends AccountStream {
  constructor() {
    super({
      name: 'identity',
      description:
        'One record: who the Google Health account is. Reloaded whole on every run.',
      properties: {
        healthUserId: {
          type: 'string',
          minLength: 1,
          description:
            "The user's id in the Google Health API, the {user} segment of every point's resource name.",
        },
        legacyUserId: {
          ...fields.text,
          description: "The user's Fitbit id, from the legacy Fitbit Web API.",
        },
      },
      primaryKey: ['healthUserId'],
    });
  }

  protected async rows(
    scan: GoogleHealthScan,
    signal: AbortSignal | undefined,
  ) {
    const { healthUserId, legacyUserId } = await scan.api.identity(
      signal && { signal },
    );
    return [{ healthUserId, legacyUserId: legacyUserId ?? null }];
  }
}
