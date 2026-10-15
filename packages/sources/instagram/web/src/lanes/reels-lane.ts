import type {
  InstagramWeb,
  Page,
  Profile,
  ReelMedia,
} from '@workspace/sdk-instagram-web';

import { Lane } from '../lane.ts';

// The profile's reels tab, which also holds reels it kept off the grid.
export class ReelsLane extends Lane<ReelMedia> {
  readonly name = 'reels';

  fetch(
    web: InstagramWeb,
    profile: Profile,
    cursor: string | null,
    signal: AbortSignal | undefined,
  ): Promise<Page<ReelMedia>> {
    return web.reels(profile.pk, cursor, signal);
  }

  id(item: ReelMedia): string {
    return item.pk;
  }

  // A reel without a pin list counts as unpinned: at worst the next run's
  // read from the top goes down to it.
  override pinned(item: ReelMedia, profile: Profile): boolean {
    return item.clips_tab_pinned_user_ids?.includes(profile.pk) ?? false;
  }
}
