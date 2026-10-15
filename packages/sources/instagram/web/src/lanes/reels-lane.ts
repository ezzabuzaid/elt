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

  override pinned(item: ReelMedia, profile: Profile): boolean {
    return item.clips_tab_pinned_user_ids.includes(profile.pk);
  }
}
