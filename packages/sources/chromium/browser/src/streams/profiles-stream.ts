import type { RecordDraft } from '@workspace/elt';

import type { ChromiumProfileEntry, ChromiumScan } from '../chromium-scan.ts';
import { ChromiumStream, chromiumFields } from '../chromium-stream.ts';

const properties = {
  id: {
    ...chromiumFields.profileId,
    description:
      'The folder of the profile in the browser’s data folder, such as Default or Profile 1. Other streams refer to it as profileId.',
  },
  name: {
    ...chromiumFields.nullableText,
    description:
      'The name the user gave the profile, from the browser’s Local State; null when Local State does not list the folder.',
  },
} as const;

export class ProfilesStream extends ChromiumStream<
  typeof properties,
  ChromiumProfileEntry
> {
  readonly name = 'profiles';
  readonly store = 'profiles';
  readonly description =
    'Each profile of the browser that holds a History or Bookmarks file.';
  readonly properties = properties;
  readonly primaryKey = ['id'];

  protected rows(scan: ChromiumScan) {
    return scan.profiles;
  }

  protected record(
    profile: ChromiumProfileEntry,
  ): RecordDraft<typeof properties> {
    return { id: profile.id, name: profile.name };
  }
}
