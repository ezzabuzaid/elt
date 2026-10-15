import type { InstagramWeb, Page, Profile } from '@workspace/sdk-instagram-web';

export type LaneName = 'posts' | 'reels' | 'reposts' | 'tagged';

// One of a profile's lists as Instagram pages it: newest first, behind the
// items the profile pinned to its top. Each list is a small subclass; the
// walk over its pages is the same for all of them.
export abstract class Lane<Item> {
  abstract readonly name: LaneName;

  abstract fetch(
    web: InstagramWeb,
    profile: Profile,
    cursor: string | null,
    signal: AbortSignal | undefined,
  ): Promise<Page<Item>>;

  abstract id(item: Item): string;

  // Whether the profile pinned the item above its newer ones.
  pinned(_item: Item, _profile: Profile): boolean {
    return false;
  }
}
