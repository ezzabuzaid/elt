import type { RecordDraft } from '@workspace/elt';
import type { SafariProfile } from '@workspace/sdk-apple-safari';

import type { SafariScan } from '../safari-scan.ts';
import { SafariStream, iso, safariFields } from '../safari-stream.ts';

const { nullableText, nullableNumber } = safariFields;
const component = { ...nullableNumber, minimum: 0, maximum: 1 } as const;

const properties = {
  id: {
    ...safariFields.id,
    description:
      'Profile identifier (external_uuid); every profileId in this source refers to it. The profile Safari starts with is DefaultProfile.',
  },
  serverId: {
    ...safariFields.id,
    description:
      'Profile iCloud identifier; names the folder Safari keeps the profile data in (DefaultProfile for the first profile).',
  },
  title: {
    ...nullableText,
    description:
      'Profile name; NULL for the default profile, which Safari shows as Personal once other profiles exist.',
  },
  position: {
    ...safariFields.integer,
    description: 'Order Safari lists profiles in.',
  },
  symbol: {
    ...nullableText,
    description: 'SF Symbol shown for the profile, such as person.fill.',
  },
  colorName: {
    ...nullableText,
    description: 'Named profile color, such as heatherBlue or clear.',
  },
  red: { ...component, description: 'Profile color red component, 0 to 1.' },
  green: {
    ...component,
    description: 'Profile color green component, 0 to 1.',
  },
  blue: { ...component, description: 'Profile color blue component, 0 to 1.' },
  alpha: {
    ...component,
    description: 'Profile color opacity, 0 to 1; 0 for clear.',
  },
  favoritesFolderServerId: {
    ...nullableText,
    description:
      'The profile own Favorites folder; bookmarks.serverId refers to the same folder once Safari has written it. NULL when the profile shares the default Favorites.',
  },
  addedAt: {
    ...safariFields.nullableTimestamp,
    description: 'When the profile was created; NULL when not recorded.',
  },
  modifiedAt: {
    ...safariFields.nullableTimestamp,
    description:
      'When Safari last changed the profile; NULL when not recorded.',
  },
} as const;

export class ProfilesStream extends SafariStream<
  typeof properties,
  SafariProfile
> {
  readonly name = 'profiles';
  readonly store = 'tabs';
  readonly primaryKey = ['id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per Safari profile (SafariTabs.db). Each profile has its own history, tabs and tab groups. Relationships name streams in this source, not physical destination tables.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: SafariScan): readonly SafariProfile[] {
    return scan.tabs.profiles;
  }

  protected record(profile: SafariProfile): RecordDraft<typeof properties> {
    const color = profile.color();
    return {
      id: profile.id,
      serverId: profile.serverId,
      title: profile.title,
      position: profile.position,
      symbol: profile.symbol,
      colorName: color.colorName,
      red: color.red,
      green: color.green,
      blue: color.blue,
      alpha: color.alpha,
      favoritesFolderServerId: profile.favoritesFolderServerId,
      addedAt: iso(profile.addedAt),
      modifiedAt: iso(profile.modifiedAt),
    };
  }
}
