import type { RecordDraft } from '@workspace/elt';

import type { SafariScan } from '../safari-scan.ts';
import { SafariStream, safariFields } from '../safari-stream.ts';
import type { Row } from '../safari-values.ts';

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
  profile: Row;
  position: number;
  section: { Identifier: string; IsEnabled: boolean };
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
    return scan.tabs.profiles.flatMap((profile) => {
      const data = scan.tabs.attributes(profile)[0].StartPageSectionsData;
      if (!(data instanceof Uint8Array)) return [];
      const { Sections }: { Sections: Section['section'][] } = JSON.parse(
        Buffer.from(data).toString('utf8'),
      );
      return Sections.map((section, position) => ({
        profile,
        position,
        section,
      }));
    });
  }

  protected record({
    profile,
    position,
    section,
  }: Section): RecordDraft<typeof properties> {
    return {
      profileId: profile.external_uuid,
      position,
      identifier: section.Identifier,
      enabled: section.IsEnabled,
    };
  }
}
