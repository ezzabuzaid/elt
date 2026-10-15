import { AccountStream } from '../account-stream.ts';
import type { GoogleHealthScan } from '../google-health-scan.ts';
import { calendarDate, fields } from '../health-fields.ts';

export class ProfileStream extends AccountStream {
  constructor() {
    super({
      name: 'profile',
      description:
        "One record: the user's Google Health profile. Reloaded whole on every run.",
      properties: {
        membershipStartDate: {
          ...fields.date,
          description:
            'The day the user created the account. Daily data and rollups are read from this day on.',
        },
        age: {
          ...fields.integer,
          description: "The user's age in years, from their birth date.",
        },
        userConfiguredWalkingStrideLengthMm: {
          ...fields.integer,
          description:
            'The walking stride length the user set, in millimeters.',
        },
        userConfiguredRunningStrideLengthMm: {
          ...fields.integer,
          description:
            'The running stride length the user set, in millimeters.',
        },
        autoWalkingStrideLengthMm: {
          ...fields.integer,
          description:
            'The walking stride length Google calculated, in millimeters.',
        },
        autoRunningStrideLengthMm: {
          ...fields.integer,
          description:
            'The running stride length Google calculated, in millimeters.',
        },
      },
    });
  }

  protected async rows(
    scan: GoogleHealthScan,
    signal: AbortSignal | undefined,
  ) {
    const profile = await scan.api.profile(signal && { signal });
    return [
      {
        membershipStartDate: calendarDate(profile.membershipStartDate),
        age: profile.age ?? null,
        userConfiguredWalkingStrideLengthMm:
          profile.userConfiguredWalkingStrideLengthMm ?? null,
        userConfiguredRunningStrideLengthMm:
          profile.userConfiguredRunningStrideLengthMm ?? null,
        autoWalkingStrideLengthMm: profile.autoWalkingStrideLengthMm ?? null,
        autoRunningStrideLengthMm: profile.autoRunningStrideLengthMm ?? null,
      },
    ];
  }
}
