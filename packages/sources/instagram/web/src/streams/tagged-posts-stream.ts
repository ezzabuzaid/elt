import type { ListMedia } from '@workspace/sdk-instagram-web';

import type { InstagramRun, LaneReader } from '../instagram-run.ts';
import {
  OthersPostsStream,
  othersPostProperties,
} from '../others-posts-stream.ts';

export class TaggedPostsStream extends OthersPostsStream {
  readonly name = 'tagged_posts';
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per post of another account that tags an Instagram profile the import reads, as the profile’s tagged tab lists them. Primary key profileId, id. Scanned as the posts stream is.',
    properties: othersPostProperties,
    required: Object.keys(othersPostProperties),
  } as const;

  protected reader(run: InstagramRun): LaneReader<ListMedia> {
    return run.tagged;
  }
}
