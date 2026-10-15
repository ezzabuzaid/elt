import type { ListMedia } from '@workspace/sdk-instagram-web';

import { fields, kindOf, postUrl } from './fields.ts';
import { ListStream } from './list-stream.ts';

const { profileId, id, text, nullableText, count, kind } = fields;

export const othersPostProperties = {
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
  owner: {
    ...text,
    description: 'The username of the account that posted it.',
  },
  caption: {
    ...nullableText,
    description: 'The post’s caption; NULL when it has none.',
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
  likes: {
    ...count,
    description:
      'How many accounts liked the post, when its page was last read.',
  },
  comments: {
    ...count,
    description: 'How many comments the post has, when its page was last read.',
  },
  slides: {
    ...count,
    description:
      'How many images or videos the post holds; 1 unless it is a carousel.',
  },
} as const;

// Another account's post, as one of the profile's tabs lists it: with no
// date, which the tab does not name.
export abstract class OthersPostsStream extends ListStream<
  typeof othersPostProperties,
  ListMedia
> {
  readonly primaryKey = ['profileId', 'id'];

  protected record(item: ListMedia, profile: string) {
    return {
      profileId: profile,
      id: item.pk,
      code: item.code,
      url: postUrl(item.code),
      owner: item.user.username,
      caption: item.caption?.text ?? null,
      kind: kindOf(item.media_type),
      productType: item.product_type,
      likes: item.like_count,
      comments: item.comment_count,
      slides: item.carousel_media?.length ?? 1,
    };
  }
}
