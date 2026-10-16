import type { TimelineMedia } from '@workspace/sdk-instagram-web';

import { fields, instant, kindOf, postUrl } from '../fields.ts';
import type { InstagramRun, LaneReader } from '../instagram-run.ts';
import { type DateRange, within } from '../instagram-stream.ts';
import { ListStream } from '../list-stream.ts';

const {
  profileId,
  id,
  text,
  nullableText,
  count,
  flag,
  instant: at,
  kind,
  textList,
} = fields;

const properties = {
  profileId,
  id: {
    ...id,
    description: 'Instagram’s id of the post. The media stream’s postId.',
  },
  code: {
    ...text,
    description: 'The post’s short code, as in instagram.com/p/<code>/.',
  },
  url: { ...text, description: 'The post’s page.' },
  postedAt: { ...at, description: 'When the post was published.' },
  caption: {
    ...nullableText,
    description:
      'The post’s caption, hashtags included; NULL when it has none. Text inside its images is in attachment_text, through the media stream.',
  },
  captionEdited: {
    ...flag,
    description: 'The caption was edited after posting.',
  },
  kind: {
    ...kind,
    description: 'photo, video, or carousel of several slides.',
  },
  productType: {
    ...text,
    description:
      'Instagram’s product type, such as feed, carousel_container, or clips for a reel.',
  },
  pinned: {
    ...flag,
    description: 'The profile pinned the post to the top of its grid.',
  },
  locationId: {
    type: ['string', 'null'],
    minLength: 1,
    description:
      'Instagram’s id of the place the post is tagged with; NULL when it has none.',
  },
  locationName: {
    ...nullableText,
    description: 'The name of the place the post is tagged with.',
  },
  latitude: {
    type: ['number', 'null'],
    description: 'The place’s latitude, in degrees.',
  },
  longitude: {
    type: ['number', 'null'],
    description: 'The place’s longitude, in degrees.',
  },
  likes: {
    ...count,
    description:
      'How many accounts liked the post, when its page was last read. 0 when the profile hides its counts.',
  },
  comments: {
    ...count,
    description:
      'How many comments the post has, replies included, when its page was last read.',
  },
  slides: {
    ...count,
    description:
      'How many images or videos the post holds; 1 unless it is a carousel.',
  },
  coauthors: {
    ...textList,
    description:
      'The usernames of the accounts that posted it together with the profile.',
  },
  tagged: {
    ...textList,
    description: 'The usernames of the accounts tagged on the post.',
  },
  description: {
    ...nullableText,
    description:
      'The description Instagram wrote of the image, when it wrote one.',
  },
} as const;

// The profile's grid.
export class PostsStream extends ListStream<typeof properties, TimelineMedia> {
  readonly name = 'posts';
  readonly primaryKey = ['profileId', 'id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per post on the grid of an Instagram profile the import reads, reels shared to the grid among them. Primary key profileId, id. Each run reads the newest posts and the next pages of a scan of the whole grid; a post the profile deleted is deleted once the scan reaches the grid’s end.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected reader(run: InstagramRun): LaneReader<TimelineMedia> {
    return run.posts;
  }

  protected override olderThan({
    startAt,
  }: DateRange): ((item: TimelineMedia) => boolean) | undefined {
    if (startAt === undefined) return undefined;
    return (item) => instant(item.taken_at) < startAt;
  }

  protected override inRange(item: TimelineMedia, range: DateRange): boolean {
    return within(range, instant(item.taken_at));
  }

  protected record(item: TimelineMedia, profile: string) {
    return {
      profileId: profile,
      id: item.pk,
      code: item.code,
      url: postUrl(item.code),
      postedAt: instant(item.taken_at),
      caption: item.caption?.text ?? null,
      captionEdited: item.caption_is_edited,
      kind: kindOf(item.media_type),
      productType: item.product_type,
      pinned: item.timeline_pinned_user_ids.includes(profile),
      locationId: item.location?.pk ?? null,
      locationName: item.location?.name ?? null,
      latitude: item.location?.lat ?? null,
      longitude: item.location?.lng ?? null,
      likes: item.like_count,
      comments: item.comment_count,
      slides: item.carousel_media?.length ?? 1,
      coauthors: item.coauthor_producers.map(({ username }) => username),
      tagged: (item.usertags?.in ?? []).map(({ user }) => user.username),
      description: item.accessibility_caption,
    };
  }
}
