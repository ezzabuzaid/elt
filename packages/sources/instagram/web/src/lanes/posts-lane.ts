import type {
  InstagramWeb,
  Page,
  Profile,
  TimelineMedia,
} from '@workspace/sdk-instagram-web';

import { Lane } from '../lane.ts';

// The profile's grid: its posts and the reels it shared to the grid.
export class PostsLane extends Lane<TimelineMedia> {
  readonly name = 'posts';

  fetch(
    web: InstagramWeb,
    profile: Profile,
    cursor: string | null,
    signal: AbortSignal | undefined,
  ): Promise<Page<TimelineMedia>> {
    return web.posts(profile.username, cursor, signal);
  }

  id(item: TimelineMedia): string {
    return item.pk;
  }

  override pinned(item: TimelineMedia, profile: Profile): boolean {
    return item.timeline_pinned_user_ids.includes(profile.pk);
  }
}
