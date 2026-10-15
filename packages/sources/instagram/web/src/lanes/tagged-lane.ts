import type {
  InstagramWeb,
  ListMedia,
  Page,
  Profile,
} from '@workspace/sdk-instagram-web';

import { Lane } from '../lane.ts';

// Other accounts' posts that tag the profile.
export class TaggedLane extends Lane<ListMedia> {
  readonly name = 'tagged';

  fetch(
    web: InstagramWeb,
    profile: Profile,
    cursor: string | null,
    signal: AbortSignal | undefined,
  ): Promise<Page<ListMedia>> {
    return web.tagged(profile.pk, cursor, signal);
  }

  id(item: ListMedia): string {
    return item.pk;
  }
}
