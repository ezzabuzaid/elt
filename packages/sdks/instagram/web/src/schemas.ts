import { z } from 'zod';

// Each schema holds the fields this package reads, typed as instagram.com's
// web client received them on 2026-10-14 and 2026-10-15 for two public
// business profiles. Every other field is dropped.

const image = z.object({
  url: z.string(),
  width: z.number(),
  height: z.number(),
});

const images = z.object({ candidates: z.array(image) });

const owner = z.object({ pk: z.string(), username: z.string() });

const caption = z.object({ text: z.string(), created_at: z.number() });

const pageInfo = z.object({
  end_cursor: z.string().nullable(),
  has_next_page: z.boolean(),
});

// One slide of a post on the profile's grid: a photo, or a video with its
// cover frame among the images.
const timelineSlide = z.object({
  pk: z.string(),
  media_type: z.number(),
  image_versions2: images,
  accessibility_caption: z.string().nullable(),
});

const timelineMedia = timelineSlide.extend({
  code: z.string(),
  taken_at: z.number(),
  product_type: z.string(),
  caption: caption.nullable(),
  caption_is_edited: z.boolean(),
  like_count: z.number(),
  comment_count: z.number(),
  like_and_view_counts_disabled: z.boolean(),
  timeline_pinned_user_ids: z.array(z.string()),
  user: owner,
  coauthor_producers: z.array(owner),
  usertags: z.object({ in: z.array(z.object({ user: owner })) }).nullable(),
  carousel_media: z.array(timelineSlide).nullable(),
});

// A slide as the tagged and reposts tabs list it: no video and no
// description.
const listSlide = z.object({
  pk: z.string(),
  media_type: z.number(),
  image_versions2: images,
});

const listMedia = listSlide.extend({
  code: z.string(),
  product_type: z.string(),
  // These tabs send a caption's text without its date.
  caption: z.object({ text: z.string() }).nullable(),
  like_count: z.number(),
  comment_count: z.number(),
  user: owner,
  carousel_media: z.array(listSlide).nullable(),
});

// A reel as the reels tab lists it: its counts and cover, with no caption
// and no date.
const reelMedia = z.object({
  pk: z.string(),
  code: z.string(),
  media_type: z.number(),
  product_type: z.string(),
  // Instagram leaves out the count of some reels.
  play_count: z.number().nullable(),
  like_count: z.number(),
  comment_count: z.number(),
  clips_tab_pinned_user_ids: z.array(z.string()),
  user: owner,
  image_versions2: images,
});

const storyItem = z.object({
  pk: z.string(),
  taken_at: z.number(),
  expiring_at: z.number(),
  media_type: z.number(),
  product_type: z.string(),
  image_versions2: images,
  accessibility_caption: z.string().nullable(),
});

const comment = z.object({
  pk: z.string(),
  text: z.string(),
  created_at: z.number(),
  // Instagram sends one commenter's id as a number and another's as a string.
  user: z.object({
    pk: z.union([z.string(), z.number()]).transform(String),
    username: z.string(),
  }),
  comment_like_count: z.number(),
});

export const followingResponse = z.object({
  users: z.array(
    z.object({
      pk: z.string(),
      username: z.string(),
      full_name: z.string(),
      is_private: z.boolean(),
      is_verified: z.boolean(),
      profile_pic_url: z.string(),
    }),
  ),
  has_more: z.boolean(),
  next_max_id: z.string().optional(),
});

export const profileResponse = z.object({
  data: z.object({
    user: z.object({
      pk: z.string(),
      username: z.string(),
      full_name: z.string(),
      biography: z.string(),
      external_url: z.string().nullable(),
      bio_links: z.array(z.object({ url: z.string() })),
      category: z.string().nullable(),
      is_private: z.boolean(),
      is_verified: z.boolean(),
      is_business: z.boolean(),
      follower_count: z.number(),
      following_count: z.number(),
      media_count: z.number(),
      total_clips_count: z.number(),
      city_name: z.string().nullable(),
      address_street: z.string().nullable(),
      hd_profile_pic_url_info: z.object({ url: z.string() }),
    }),
  }),
});

export const postsResponse = z.object({
  data: z.object({
    xdt_api__v1__feed__user_timeline_graphql_connection: z.object({
      edges: z.array(z.object({ node: timelineMedia })),
      page_info: pageInfo,
    }),
  }),
});

export const reelsResponse = z.object({
  data: z.object({
    fetch__XDTUserDict: z.object({
      clips_connection: z.object({
        edges: z.array(z.object({ node: z.object({ media: reelMedia }) })),
        page_info: pageInfo,
      }),
    }),
  }),
});

export const repostsResponse = z.object({
  data: z.object({
    fetch__XDTUserDict: z.object({
      user_reposts_timeline: z.object({
        repost_grid_items: z.array(z.object({ media: listMedia })),
        repost_more_available: z.boolean(),
        repost_next_max_id: z.string().nullable(),
      }),
    }),
  }),
});

export const taggedResponse = z.object({
  data: z.object({
    xdt_api__v1__usertags__user_id__feed_connection: z.object({
      edges: z.array(z.object({ node: listMedia })),
      page_info: pageInfo,
    }),
  }),
});

export const highlightsResponse = z.object({
  data: z.object({
    highlights: z.object({
      edges: z.array(
        z.object({
          node: z.object({
            id: z.string(),
            title: z.string(),
            cover_media: z.object({
              cropped_image_version: z.object({ url: z.string() }),
            }),
          }),
        }),
      ),
    }),
  }),
});

export const reelsMediaResponse = z.object({
  data: z.object({
    xdt_api__v1__feed__reels_media__connection: z.object({
      edges: z.array(
        z.object({
          node: z.object({ id: z.string(), items: z.array(storyItem) }),
        }),
      ),
      page_info: pageInfo,
    }),
  }),
});

export const commentsResponse = z.object({
  comments: z.array(comment.extend({ child_comment_count: z.number() })),
  has_more_comments: z.boolean(),
  next_min_id: z.string().optional(),
});

export const repliesResponse = z.object({
  child_comments: z.array(comment),
  has_more_tail_child_comments: z.boolean(),
  next_max_child_cursor: z.string().optional(),
});

export type TimelineMedia = z.infer<typeof timelineMedia>;
export type ListMedia = z.infer<typeof listMedia>;
export type ReelMedia = z.infer<typeof reelMedia>;
export type StoryItem = z.infer<typeof storyItem>;
export type Image = z.infer<typeof image>;
export type FollowedAccount = z.infer<
  typeof followingResponse
>['users'][number];
export type Profile = z.infer<typeof profileResponse>['data']['user'];
export type Highlight = z.infer<
  typeof highlightsResponse
>['data']['highlights']['edges'][number]['node'];
export type Comment = z.infer<typeof comment>;
export type TopComment = z.infer<typeof commentsResponse>['comments'][number];
