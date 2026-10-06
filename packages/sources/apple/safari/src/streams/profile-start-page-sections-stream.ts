import type { RecordDraft } from '@workspace/elt';
import type { StartPageSection } from '@workspace/sdk-apple-safari';

import type { SafariScan } from '../safari-scan.ts';
import { SafariStream, safariFields } from '../safari-stream.ts';

const properties = {
  profileId: safariFields.profileId,
  position: {
    ...safariFields.ordinal,
    description: 'Order of the section on the Start Page.',
  },
  identifier: {
    ...safariFields.id,
    description:
      'Start Page section, such as favoritesItemIdentifier or readingListItemIdentifier.',
  },
  enabled: {
    ...safariFields.boolean,
    description: 'Whether the Start Page shows the section.',
  },
} as const;

type Section = {
  readonly profileId: string | null;
  readonly section: StartPageSection;
};

export class ProfileStartPageSectionsStream extends SafariStream<
  typeof properties,
  Section
> {
  readonly name = 'profileStartPageSections';
  readonly store = 'tabs';
  readonly primaryKey = ['profileId', 'position'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per Start Page section a profile customized (SafariTabs.db StartPageSectionsData). A profile that never customized its Start Page has none. Relationships name streams in this source, not physical destination tables.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: SafariScan): readonly Section[] {
    return scan.tabs.profiles.flatMap((profile) =>
      profile
        .startPageSections()
        .map((section) => ({ profileId: profile.id, section })),
    );
  }

  protected record({
    profileId,
    section,
  }: Section): RecordDraft<typeof properties> {
    return {
      profileId,
      position: section.position,
      identifier: section.identifier,
      enabled: section.enabled,
    };
  }
}
