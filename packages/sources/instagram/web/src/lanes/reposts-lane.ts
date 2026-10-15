import type {
  InstagramWeb,
  ListMedia,
  Page,
  Profile,
} from '@workspace/sdk-instagram-web';

import { Lane } from '../lane.ts';

// Other accounts' posts the profile reposted, the latest repost first.
export class RepostsLane extends Lane<ListMedia> {
  readonly name = 'reposts';

  fetch(
    web: InstagramWeb,
    profile: Profile,
    cursor: string | null,
    signal: AbortSignal | undefined,
  ): Promise<Page<ListMedia>> {
    return web.reposts(profile.pk, cursor, signal);
  }

  id(item: ListMedia): string {
    return item.pk;
  }
}
