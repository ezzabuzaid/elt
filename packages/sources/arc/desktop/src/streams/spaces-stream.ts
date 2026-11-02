import type { ArcSidebarContent } from '@workspace/sdk-arc-desktop';

import { ArcStream, fields } from '../arc-stream.ts';

const properties = {
  id: { ...fields.id, description: 'The space’s ID.' },
  position: {
    ...fields.position,
    description: 'The place of the space in the sidebar, from 0.',
  },
  title: {
    ...fields.nullableText,
    description: 'The name the user gave the space; null when it has none.',
  },
  profileId: fields.profileId,
  profileMachineId: {
    ...fields.nullableText,
    description:
      'The ID Arc gives the Mac that made the profile; null for the Default profile.',
  },
  emoji: {
    ...fields.nullableText,
    description:
      'The emoji the user gave the space as its icon; null when none.',
  },
  customInfo: {
    ...fields.text,
    description:
      'The space’s theme and icon as the JSON Arc writes (customInfo): windowTheme holds the colors, iconType the icon.',
  },
} as const;

export class SpacesStream extends ArcStream<typeof properties> {
  readonly name = 'spaces';
  readonly description =
    'The spaces of Arc’s sidebar, in sidebar order. Each space belongs to one profile.';
  readonly properties = properties;

  protected rows({ spaces }: ArcSidebarContent) {
    return spaces.map((space) => ({
      id: space.id,
      position: space.position,
      title: space.title,
      profileId: space.profile.id,
      profileMachineId: space.profile.machineId,
      emoji: space.emoji,
      customInfo: space.customInfo,
    }));
  }
}
