import { fields } from '../fields.ts';
import type { ReadContext } from '../instagram-stream.ts';
import { type Snapshot, SnapshotStream } from '../snapshot-stream.ts';

const { profileId, text, nullableText, count, flag, textList } = fields;

const properties = {
  profileId,
  username: {
    ...text,
    description: 'The profile’s username, as in instagram.com/<username>.',
  },
  fullName: { ...text, description: 'The name the profile shows.' },
  biography: { ...text, description: 'The profile’s bio text.' },
  externalUrl: { ...nullableText, description: 'The first link of the bio.' },
  links: { ...textList, description: 'Every link of the bio, in order.' },
  category: {
    ...nullableText,
    description:
      'The business category the profile shows, such as Gym/Physical Fitness Center.',
  },
  isPrivate: {
    ...flag,
    description: 'Only the profile’s followers see its posts.',
  },
  isVerified: { ...flag, description: 'Instagram verified the profile.' },
  isBusiness: { ...flag, description: 'The profile is a business account.' },
  followers: {
    ...count,
    description: 'How many accounts follow the profile, when read.',
  },
  following: {
    ...count,
    description: 'How many accounts the profile follows, when read.',
  },
  posts: {
    ...count,
    description: 'How many posts Instagram counts on the profile, when read.',
  },
  reels: {
    ...count,
    description: 'How many reels Instagram counts on the profile, when read.',
  },
  city: {
    ...nullableText,
    description: 'The city of the business address the profile shows.',
  },
  street: {
    ...nullableText,
    description: 'The street of the business address the profile shows.',
  },
} as const;

export class ProfilesStream extends SnapshotStream<typeof properties> {
  readonly name = 'profiles';
  readonly primaryKey = ['profileId'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per Instagram profile the import reads, as its page shows it now. Primary key profileId.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected async scan({
    run,
    profileId: id,
    signal,
  }: ReadContext): Promise<Snapshot<typeof properties>> {
    if (id === null)
      throw new TypeError('Instagram profiles are read by profile');
    const profile = await run.profile(id, signal);
    return {
      records: [
        {
          profileId: id,
          username: profile.username,
          fullName: profile.full_name,
          biography: profile.biography,
          externalUrl: profile.external_url,
          links: profile.bio_links.map(({ url }) => url),
          category: profile.category,
          isPrivate: profile.is_private,
          isVerified: profile.is_verified,
          isBusiness: profile.is_business,
          followers: profile.follower_count,
          following: profile.following_count,
          posts: profile.media_count,
          reels: profile.total_clips_count,
          city: profile.city_name,
          street: profile.address_street,
        },
      ],
    };
  }
}
