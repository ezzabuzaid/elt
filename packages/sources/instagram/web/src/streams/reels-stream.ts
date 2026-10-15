import type { ReelMedia } from '@workspace/sdk-instagram-web';

import { fields, reelUrl } from '../fields.ts';
import type { InstagramRun, LaneReader } from '../instagram-run.ts';
import { ListStream } from '../list-stream.ts';

const { profileId, id, text, count } = fields;

const properties = {
  profileId,
  id: {
    ...id,
    description:
      'Instagram’s id of the reel. The posts stream’s id when the reel is on the grid too.',
  },
  code: {
    ...text,
    description: 'The reel’s short code, as in instagram.com/reel/<code>/.',
  },
  url: { ...text, description: 'The reel’s page.' },
  plays: {
    type: ['integer', 'null'],
    minimum: 0,
    description:
      'How many times the reel was played, when its page was last read; NULL when Instagram does not show the count.',
  },
  likes: {
    ...count,
    description:
      'How many accounts liked the reel, when its page was last read.',
  },
  comments: {
    ...count,
    description: 'How many comments the reel has, when its page was last read.',
  },
  pinned: {
    type: ['boolean', 'null'],
    description:
      'The profile pinned the reel to the top of its reels tab; NULL when Instagram does not say.',
  },
} as const;

// The profile's reels tab. The tab names no date and no caption: a reel on
// the grid has them in the posts stream.
export class ReelsStream extends ListStream<typeof properties, ReelMedia> {
  readonly name = 'reels';
  readonly primaryKey = ['profileId', 'id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per reel on the reels tab of an Instagram profile the import reads, reels kept off the grid among them. Primary key profileId, id. Join id to posts.id for the caption and date of a reel that is on the grid too. Scanned as the posts stream is.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected reader(run: InstagramRun): LaneReader<ReelMedia> {
    return run.reels;
  }

  protected record(item: ReelMedia, profile: string) {
    return {
      profileId: profile,
      id: item.pk,
      code: item.code,
      url: reelUrl(item.code),
      plays: item.play_count,
      likes: item.like_count,
      comments: item.comment_count,
      pinned: item.clips_tab_pinned_user_ids?.includes(profile) ?? null,
    };
  }
}
