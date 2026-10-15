import type { ListMedia } from '@workspace/sdk-instagram-web';

import type { InstagramRun, LaneReader } from '../instagram-run.ts';
import {
  OthersPostsStream,
  othersPostProperties,
} from '../others-posts-stream.ts';

export class RepostsStream extends OthersPostsStream {
  readonly name = 'reposts';
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per post of another account that an Instagram profile the import reads reposted, the latest repost first on the profile’s reposts tab. Primary key profileId, id. Scanned as the posts stream is.',
    properties: othersPostProperties,
    required: Object.keys(othersPostProperties),
  } as const;

  protected reader(run: InstagramRun): LaneReader<ListMedia> {
    return run.reposts;
  }
}
