import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempDisposable, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';

import {
  Connection,
  Copy,
  type CopyResult,
  LocalFiles,
  Pipeline,
  PipelineError,
  type Stream,
  type Target,
} from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteColumns,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';
import { ScratchMac } from '@workspace/sdk-chromium-cookies/test';

import { InstagramWebSource } from './instagram-web-source.ts';

// --- The Mac: a browser profile signed in to Instagram ---------------------

const viewer = '1691';
const sessionCookies = {
  sessionid: `${viewer}%3Asession`,
  csrftoken: 'csrf-token',
  ds_user_id: viewer,
};

// A Mac whose Dia is signed in to Instagram, which HOME points at until the
// test ends.
async function signedInMac() {
  const mac = await ScratchMac.create();
  const password = randomUUID();
  mac.safeStorage('Dia Safe Storage', 'Dia', password);
  mac.cookies(
    'Dia/User Data/Default',
    password,
    Object.entries(sessionCookies).map(([name, value]) => ({
      host: '.instagram.com',
      name,
      value,
      days: 300,
    })),
  );
  const previous = process.env.HOME;
  process.env.HOME = mac.path;
  return {
    path: mac.path,
    async [Symbol.asyncDispose]() {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
      await mac[Symbol.asyncDispose]();
    },
  };
}

// --- Instagram: profiles served the way instagram.com serves them ----------

type Comment = {
  readonly pk: string;
  readonly text: string;
  readonly replies?: readonly Comment[];
};

type Post = {
  readonly pk: string;
  readonly code?: string;
  readonly takenAt: number;
  readonly caption?: string | null;
  readonly pinned?: boolean;
  readonly slides?: number;
  readonly video?: boolean;
  readonly comments?: readonly Comment[];
  readonly owner?: string;
  // A reel's play count; null where Instagram leaves it out.
  readonly plays?: number | null;
};

type Story = {
  readonly pk: string;
  readonly takenAt: number;
  readonly expiresAt: number;
};

type Profile = {
  readonly pk: string;
  readonly username: string;
  posts: Post[];
  reels?: Post[];
  reposts?: Post[];
  tagged?: Post[];
  stories?: Story[];
  highlights?: {
    readonly id: string;
    readonly title: string;
    items: Story[];
  }[];
};

type World = {
  profiles: Profile[];
  following: { readonly pk: string; readonly username: string }[];
  // Instagram answers as it answers a browser not signed in.
  signedOut?: boolean;
  // Instagram answers 429 once this many GraphQL queries were answered.
  queriesUntilLimit?: number;
};

type Call = {
  readonly name: string;
  readonly variables: Readonly<Record<string, unknown>>;
};

const cdn = 'https://scontent.cdninstagram.com';
const imageOf = (id: string) =>
  `${cdn}/v/t51.2885-15/${id}_n.jpg?stp=dst-jpg&_nc_ht=scontent&oh=signature`;
const bytesOf = (id: string) => `image of ${id}`;

const images = (id: string) => ({
  candidates: [
    { url: imageOf(`${id}-small`), width: 320, height: 400 },
    { url: imageOf(id), width: 1080, height: 1350 },
  ],
});

const commentCount = (comments: readonly Comment[] = []) =>
  comments.reduce((sum, { replies = [] }) => sum + 1 + replies.length, 0);

const mediaType = (post: Post) =>
  (post.slides ?? 1) > 1 ? 8 : post.video ? 2 : 1;

const slidesOf = (post: Post) =>
  (post.slides ?? 1) > 1
    ? Array.from({ length: post.slides ?? 1 }, (_, index) => ({
        pk: `${post.pk}0${index}`,
        media_type: 1,
        image_versions2: images(`${post.pk}0${index}`),
        video_versions: null,
        accessibility_caption: null,
      }))
    : null;

function timelineNode(post: Post, profile: Profile) {
  return {
    pk: post.pk,
    id: `${post.pk}_${profile.pk}`,
    code: post.code ?? `C${post.pk}`,
    taken_at: post.takenAt,
    media_type: mediaType(post),
    product_type:
      (post.slides ?? 1) > 1
        ? 'carousel_container'
        : post.video
          ? 'clips'
          : 'feed',
    image_versions2: images(post.pk),
    video_versions: post.video
      ? [
          {
            url: `${cdn}/o1/v/${post.pk}.mp4?oh=signature`,
            width: 720,
            height: 1280,
          },
        ]
      : null,
    accessibility_caption: null,
    caption:
      post.caption === null
        ? null
        : { text: post.caption ?? `Post ${post.pk}`, created_at: post.takenAt },
    caption_is_edited: false,
    like_count: 7,
    comment_count: commentCount(post.comments),
    like_and_view_counts_disabled: false,
    timeline_pinned_user_ids: post.pinned ? [profile.pk] : [],
    user: { pk: profile.pk, username: profile.username },
    coauthor_producers: [],
    usertags: null,
    carousel_media: slidesOf(post),
  };
}

function listNode(post: Post) {
  return {
    pk: post.pk,
    code: post.code ?? `C${post.pk}`,
    product_type: (post.slides ?? 1) > 1 ? 'carousel_container' : 'feed',
    caption: {
      text: post.caption ?? `Post ${post.pk}`,
      created_at: post.takenAt,
    },
    like_count: 3,
    comment_count: 0,
    user: { pk: '777', username: post.owner ?? 'someone' },
    media_type: mediaType(post),
    image_versions2: images(post.pk),
    carousel_media:
      (slidesOf(post) ?? null)?.map(({ pk, media_type, image_versions2 }) => ({
        pk,
        media_type,
        image_versions2,
      })) ?? null,
  };
}

function reelNode(post: Post, profile: Profile) {
  return {
    pk: post.pk,
    code: post.code ?? `R${post.pk}`,
    media_type: 2,
    product_type: 'clips',
    play_count: post.plays === undefined ? 120 : post.plays,
    like_count: 9,
    comment_count: 0,
    clips_tab_pinned_user_ids: post.pinned ? [profile.pk] : [],
    user: { pk: profile.pk, username: profile.username },
    image_versions2: images(post.pk),
  };
}

const storyNode = (story: Story) => ({
  pk: story.pk,
  taken_at: story.takenAt,
  expiring_at: story.expiresAt,
  media_type: 1,
  product_type: 'story',
  image_versions2: images(story.pk),
  video_versions: null,
  accessibility_caption: null,
});

// One page of a list, cursors being positions in it.
function paged<Item>(list: readonly Item[], after: unknown, first: number) {
  const start = typeof after === 'string' ? Number(after) : 0;
  const end = start + first;
  const next = end < list.length ? String(end) : null;
  return {
    items: list.slice(start, end),
    next,
    page_info: {
      end_cursor: next,
      has_next_page: next !== null,
      has_previous_page: start > 0,
      start_cursor: null,
    },
  };
}

// One page of a grid. As Instagram's, the cursor names the page's last
// post, and the next page starts at the first unpinned post older than it,
// so a post deleted above a cursor does not move the pages below it.
function gridPage(list: readonly Post[], after: unknown, first: number) {
  const start =
    typeof after === 'string'
      ? list.findIndex(
          ({ pk, pinned }) => !pinned && BigInt(pk) < BigInt(after),
        )
      : 0;
  const items = start === -1 ? [] : list.slice(start, start + first);
  const more = start !== -1 && start + first < list.length;
  const next = more ? (items.at(-1)?.pk ?? null) : null;
  return {
    items,
    page_info: {
      end_cursor: next,
      has_next_page: next !== null,
      has_previous_page: start > 0,
      start_cursor: null,
    },
  };
}

// The tokens a signed-in instagram.com page carries.
const page = `<!DOCTYPE html><html><body><script>s.handle({"define":[["DTSGInitialData",[],{"token":"dtsg-token"},258],["LSD",[],{"token":"lsd-token"},323]]})</script></body></html>`;
const webPage = () =>
  new HttpResponse('<!DOCTYPE html><html lang="en"></html>', {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });

/**
 * instagram.com and its image CDN for one test, stubbed below fetch with
 * msw and answered from world, which the test changes between runs. A
 * call is answered only when it carries what a signed-in browser sends;
 * any other host fails the test.
 */
function instagram(world: World) {
  const calls: Call[] = [];
  const downloads: string[] = [];
  const signed = (request: Request) => {
    const cookie = request.headers.get('cookie') ?? '';
    return (
      cookie.includes(`sessionid=${sessionCookies.sessionid}`) &&
      request.headers.get('x-csrftoken') === sessionCookies.csrftoken
    );
  };
  const byId = (id: unknown) => world.profiles.find(({ pk }) => pk === id);
  const graphql = (name: string, variables: Record<string, unknown>) => {
    if (name === 'PolarisProfilePageContentQuery') {
      const profile = byId(variables.id);
      if (profile === undefined) return Response.json({ data: { user: null } });
      return Response.json({
        data: {
          user: {
            pk: profile.pk,
            username: profile.username,
            full_name: profile.username.toUpperCase(),
            biography: 'Bio',
            external_url: null,
            bio_links: [],
            category: 'Gym/Physical Fitness Center',
            is_private: false,
            is_verified: false,
            is_business: true,
            follower_count: 5820,
            following_count: 12,
            media_count: profile.posts.length,
            total_clips_count: profile.reels?.length ?? 0,
            city_name: 'Amman',
            address_street: null,
            hd_profile_pic_url_info: { url: imageOf(`${profile.pk}-avatar`) },
          },
        },
      });
    }
    if (name === 'PolarisProfilePostsTabContentQuery_connection') {
      const profile = world.profiles.find(
        ({ username }) => username === variables.username,
      );
      if (profile === undefined)
        return Response.json({
          data: null,
          errors: [{ message: 'no such user' }],
        });
      const { items, page_info } = gridPage(
        profile.posts,
        variables.after,
        Number(variables.first),
      );
      return Response.json({
        data: {
          xdt_api__v1__feed__user_timeline_graphql_connection: {
            edges: items.map((post) => ({ node: timelineNode(post, profile) })),
            page_info,
          },
        },
      });
    }
    if (name === 'PolarisProfileReelsTabContentQuery_connection') {
      const profile = byId(variables.id);
      const { items, page_info } = paged(
        profile?.reels ?? [],
        variables.after,
        Number(variables.first),
      );
      return Response.json({
        data: {
          fetch__XDTUserDict: {
            clips_connection: {
              edges: items.map((post) => ({
                node: {
                  media: profile === undefined ? null : reelNode(post, profile),
                },
              })),
              page_info,
            },
          },
        },
      });
    }
    if (
      name === 'PolarisProfileRepostsTabContentQuery' ||
      name === 'PolarisProfileRepostsTabContentRefetchQuery'
    ) {
      const profile = byId(variables.user_id ?? variables.id);
      const { items, next } = paged(
        profile?.reposts ?? [],
        variables.max_id,
        12,
      );
      return Response.json({
        data: {
          fetch__XDTUserDict: {
            user_reposts_timeline: {
              repost_grid_items: items.map((post) => ({
                media: listNode(post),
              })),
              repost_more_available: next !== null,
              repost_next_max_id: next,
            },
          },
        },
      });
    }
    if (name === 'PolarisProfileTaggedTabContentQuery_connection') {
      const profile = byId(variables.user_id);
      const { items, page_info } = paged(
        profile?.tagged ?? [],
        variables.after,
        Number(variables.first),
      );
      return Response.json({
        data: {
          xdt_api__v1__usertags__user_id__feed_connection: {
            edges: items.map((post) => ({ node: listNode(post) })),
            page_info,
          },
        },
      });
    }
    if (name === 'PolarisProfileStoryHighlightsTrayContentQuery') {
      const profile = byId(variables.user_id);
      return Response.json({
        data: {
          highlights: {
            edges: (profile?.highlights ?? []).map(({ id, title }) => ({
              node: {
                id: `highlight:${id}`,
                title,
                cover_media: {
                  cropped_image_version: { url: imageOf(`${id}-cover`) },
                },
              },
            })),
          },
        },
      });
    }
    if (name === 'PolarisStoriesV3HighlightsPageQuery') {
      const [userId] = Array.isArray(variables.reel_ids)
        ? variables.reel_ids
        : [];
      const profile = byId(userId);
      const stories = profile?.stories ?? [];
      return Response.json({
        data: {
          xdt_api__v1__feed__reels_media__connection: {
            edges:
              stories.length === 0
                ? []
                : [
                    {
                      node: {
                        id: String(userId),
                        items: stories.map(storyNode),
                      },
                    },
                  ],
            page_info: { end_cursor: null, has_next_page: false },
          },
        },
      });
    }
    if (name === 'PolarisStoriesV3HighlightsPagePaginationQuery') {
      const ids = Array.isArray(variables.reel_ids)
        ? variables.reel_ids.map(String)
        : [];
      const highlights = world.profiles.flatMap(
        ({ highlights = [] }) => highlights,
      );
      const { items, page_info } = paged(
        ids,
        variables.after,
        Number(variables.first),
      );
      return Response.json({
        data: {
          xdt_api__v1__feed__reels_media__connection: {
            edges: items.map((id) => ({
              node: {
                id,
                items: (
                  highlights.find(
                    (highlight) => `highlight:${highlight.id}` === id,
                  )?.items ?? []
                ).map(storyNode),
              },
            })),
            page_info,
          },
        },
      });
    }
    return Response.json(
      {
        message: 'invalid request',
        errors: [
          {
            message: 'execution error',
            code: 1675002,
            summary: 'Incorrect Query',
          },
        ],
        status: 'fail',
      },
      { status: 400 },
    );
  };
  const server = setupServer(
    http.get('https://www.instagram.com/', ({ request }) =>
      request.headers
        .get('cookie')
        ?.includes(`sessionid=${sessionCookies.sessionid}`)
        ? new HttpResponse(page, { headers: { 'content-type': 'text/html' } })
        : new HttpResponse(null, { status: 403 }),
    ),
    http.post(
      'https://www.instagram.com/graphql/query',
      async ({ request }) => {
        const form = new URLSearchParams(await request.text());
        if (
          !signed(request) ||
          form.get('fb_dtsg') !== 'dtsg-token' ||
          form.get('lsd') !== 'lsd-token'
        )
          return new HttpResponse(null, { status: 403 });
        if (world.signedOut) return webPage();
        const name = form.get('fb_api_req_friendly_name') ?? '';
        const variables: Record<string, unknown> = JSON.parse(
          form.get('variables') ?? '{}',
        );
        if (world.queriesUntilLimit !== undefined) {
          if (world.queriesUntilLimit === 0)
            return new HttpResponse(
              '<html><body>Please wait a few minutes before you try again.</body></html>',
              {
                status: 429,
                headers: { 'content-type': 'text/html' },
              },
            );
          world.queriesUntilLimit -= 1;
        }
        calls.push({ name, variables });
        return graphql(name, variables);
      },
    ),
    http.get(
      `https://www.instagram.com/api/v1/friendships/${viewer}/following/`,
      ({ request }) => {
        if (!signed(request)) return new HttpResponse(null, { status: 403 });
        const url = new URL(request.url);
        const { items, next } = paged(
          world.following,
          url.searchParams.get('max_id'),
          Number(url.searchParams.get('count')),
        );
        return Response.json({
          users: items.map(({ pk, username }) => ({
            pk,
            username,
            full_name: username.toUpperCase(),
            is_private: false,
            is_verified: false,
            profile_pic_url: imageOf(`${pk}-avatar`),
          })),
          has_more: next !== null,
          ...(next === null ? {} : { next_max_id: next }),
          status: 'ok',
        });
      },
    ),
    http.get(
      'https://www.instagram.com/api/v1/media/:media/comments/:comment/child_comments/',
      ({ request, params }) => {
        if (!signed(request)) return new HttpResponse(null, { status: 403 });
        const comment = world.profiles
          .flatMap(({ posts }) => posts)
          .flatMap(({ comments = [] }) => comments)
          .find(({ pk }) => pk === params.comment);
        return Response.json({
          child_comments: (comment?.replies ?? []).map((reply) =>
            commentNode(reply, String(params.comment)),
          ),
          has_more_head_child_comments: false,
          has_more_tail_child_comments: false,
          status: 'ok',
        });
      },
    ),
    http.get(
      'https://www.instagram.com/api/v1/media/:media/comments/',
      ({ request, params }) => {
        if (!signed(request)) return new HttpResponse(null, { status: 403 });
        calls.push({ name: 'comments', variables: { media: params.media } });
        const post = world.profiles
          .flatMap(({ posts }) => posts)
          .find(({ pk }) => pk === params.media);
        return Response.json({
          comments: (post?.comments ?? []).map((comment) => ({
            ...commentNode(comment),
            child_comment_count: comment.replies?.length ?? 0,
          })),
          comment_count: commentCount(post?.comments),
          has_more_comments: false,
          status: 'ok',
        });
      },
    ),
    http.get(`${cdn}/*`, ({ request }) => {
      const id = /\/([^/]+)_n\.jpg$/.exec(new URL(request.url).pathname)?.[1];
      if (id === undefined) return new HttpResponse(null, { status: 404 });
      downloads.push(id);
      return new HttpResponse(bytesOf(id), {
        headers: { 'content-type': 'image/jpeg' },
      });
    }),
  );
  server.listen({ onUnhandledRequest: 'error' });
  return { calls, downloads, [Symbol.dispose]: () => server.close() };
}

function commentNode(comment: Comment, parent?: string) {
  return {
    pk: comment.pk,
    text: comment.text,
    created_at: 1791104429,
    user: { pk: Number(comment.pk.length), username: `fan${comment.pk}` },
    comment_like_count: 2,
    ...(parent === undefined ? {} : { parent_comment_id: parent }),
  };
}

// --- The load: every stream into SQLite, as the Apple hosts load it --------

async function pipeline(source: InstagramWebSource, directory: string) {
  const destination = new SQLiteDestination({
    path: join(directory, 'out.sqlite'),
  });
  const files = new LocalFiles({ directory: join(directory, 'files') });
  const { streams } = await source.discover();
  const history = new SQLiteSyncHistory();
  await history.install([destination]);
  return new Pipeline({
    history,
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints: new SQLiteCheckpointStore({
          path: join(directory, 'state.sqlite'),
        }),
        steps: streams.map(
          (stream: Stream) =>
            new Copy(
              stream,
              destination.table(
                stream.name,
                stream.supportsFileTransfer
                  ? (columns) => [
                      ...SQLiteColumns.fromSchema(stream.jsonSchema),
                      columns
                        .text('attachmentRef')
                        .from(stream.file.store(files)),
                    ]
                  : undefined,
              ),
              {
                id: stream.name,
                syncMode: 'incremental',
                destinationSyncMode: 'append_dedup',
              },
            ),
        ),
      }),
    ],
  });
}

function rows(directory: string, sql: string) {
  using db = new DatabaseSync(join(directory, 'out.sqlite'), {
    readOnly: true,
  });
  return db
    .prepare(sql)
    .all()
    .map((row) => ({ ...row }));
}

const ids = (directory: string, sql: string) =>
  rows(directory, sql).map(({ id }) => String(id));

const counts = (results: readonly CopyResult<Target>[]) =>
  Object.fromEntries(
    results.map(({ copy, count, deleted }) => [
      copy.from.name,
      { count, deleted },
    ]),
  );

// A run that fails: the error each failed copy reports, by stream.
async function failedRun(run: Promise<unknown>) {
  const error = await run.then(
    () => assert.fail('the run succeeded'),
    (failure: unknown) => failure,
  );
  assert.ok(error instanceof PipelineError);
  return Object.fromEntries(
    error.results
      .filter(({ failures }) => failures.length > 0)
      .map(({ copy, failures }) => [copy.from.name, failures]),
  );
}

// Posts newest first, one a day back from a fixed day, so a test can name
// a post's day by its place.
const day = 1791100000;
const posts = (count: number, from = 0) =>
  Array.from({ length: count }, (_, index) => ({
    pk: String(5_000_000 + from + count - index),
    takenAt: day - (from + index) * 86_400,
  }));

const hive = (posts: Post[]): Profile => ({
  pk: '44555906095',
  username: 'hivefitnationgym',
  posts,
});

// The cursors of the pages that start at these places of a grid.
const cursorsAt = (list: readonly Post[], places: readonly number[]) =>
  places.map((place) => (place === 0 ? null : (list[place - 1]?.pk ?? null)));

const timelinePages = (calls: readonly Call[]) =>
  calls
    .filter(
      ({ name }) => name === 'PolarisProfilePostsTabContentQuery_connection',
    )
    .map(({ variables }) => variables.after ?? null);

// --- Tests -------------------------------------------------------------------

test('a run reads at most 10 pages of a list, and the next run goes on with the page after them', async () => {
  await using _mac = await signedInMac();
  await using dir = await mkdtempDisposable(join(tmpdir(), 'instagram-load-'));
  const profile = hive(posts(400));
  const world: World = { profiles: [profile], following: [] };
  using wire = instagram(world);
  const source = await InstagramWebSource.connect({
    profileIds: ['44555906095'],
  });
  const run = await pipeline(source, dir.path);

  await run.run();
  const first = timelinePages(wire.calls);
  wire.calls.length = 0;
  await run.run();
  const second = timelinePages(wire.calls);

  assert.deepEqual(
    first,
    cursorsAt(profile.posts, [0, 33, 66, 99, 132, 165, 198, 231, 264, 297]),
  );
  assert.deepEqual(second, cursorsAt(profile.posts, [0, 330, 363, 396]));
  assert.equal(rows(dir.path, 'SELECT count(*) AS n FROM posts')[0]?.n, 400);
});

test('a rate limit in the middle of a scan keeps the pages committed before it, and the next run goes on after them', async () => {
  await using _mac = await signedInMac();
  await using dir = await mkdtempDisposable(join(tmpdir(), 'instagram-load-'));
  // The profile query and two pages are answered; the third page is refused.
  const profile = hive(posts(100));
  const world: World = {
    profiles: [profile],
    following: [],
    queriesUntilLimit: 3,
  };
  using wire = instagram(world);
  const run = await pipeline(
    await InstagramWebSource.connect({ profileIds: ['44555906095'] }),
    dir.path,
  );

  const failed = await failedRun(run.run());
  const committed = rows(dir.path, 'SELECT count(*) AS n FROM posts')[0]?.n;
  world.queriesUntilLimit = undefined;
  wire.calls.length = 0;
  await run.run();

  assert.match(String(failed.posts?.[0]?.error), /Instagram asked to wait/);
  assert.equal(failed.posts?.[0]?.failureType, 'system');
  assert.equal(committed, 66);
  assert.deepEqual(
    timelinePages(wire.calls),
    cursorsAt(profile.posts, [0, 66, 99]),
  );
  assert.equal(rows(dir.path, 'SELECT count(*) AS n FROM posts')[0]?.n, 100);
});

test('while a scan is under way no post is deleted; a post deleted before the scan reaches it goes when the scan ends, and one deleted after it was listed goes when the next scan ends', async () => {
  await using _mac = await signedInMac();
  await using dir = await mkdtempDisposable(join(tmpdir(), 'instagram-load-'));
  const profile = hive(posts(400));
  using _wire = instagram({ profiles: [profile], following: [] });
  const run = await pipeline(
    await InstagramWebSource.connect({ profileIds: ['44555906095'] }),
    dir.path,
  );
  const listed = String(profile.posts[5]?.pk);
  const unlisted = String(profile.posts[350]?.pk);
  // The first scan loads every post, over two runs.
  await run.run();
  await run.run();

  const underWay = counts(await run.run());
  profile.posts = profile.posts.filter(
    ({ pk }) => pk !== listed && pk !== unlisted,
  );
  const ended = counts(await run.run());
  const afterScan = ids(dir.path, 'SELECT id FROM posts');
  await run.run();
  const nextEnded = counts(await run.run());

  assert.deepEqual(underWay.posts, { count: 0, deleted: 0 });
  assert.equal(ended.posts?.deleted, 1);
  assert.ok(!afterScan.includes(unlisted));
  assert.ok(afterScan.includes(listed));
  assert.equal(nextEnded.posts?.deleted, 1);
  assert.ok(!ids(dir.path, 'SELECT id FROM posts').includes(listed));
  assert.equal(rows(dir.path, 'SELECT count(*) AS n FROM posts')[0]?.n, 398);
});

test('a post published while a scan is under way loads at the next run', async () => {
  await using _mac = await signedInMac();
  await using dir = await mkdtempDisposable(join(tmpdir(), 'instagram-load-'));
  const profile = hive(posts(400));
  using _wire = instagram({ profiles: [profile], following: [] });
  const run = await pipeline(
    await InstagramWebSource.connect({ profileIds: ['44555906095'] }),
    dir.path,
  );
  await run.run();

  profile.posts = [
    {
      pk: '6000000',
      takenAt: day + 86_400,
      caption: 'Our November schedules are now available.',
    },
    ...profile.posts,
  ];
  await run.run();

  assert.deepEqual(
    rows(dir.path, `SELECT caption FROM posts WHERE id = '6000000'`),
    [{ caption: 'Our November schedules are now available.' }],
  );
});

test('an old post pinned above the newest ones does not stop the read of new posts at the top', async () => {
  await using _mac = await signedInMac();
  await using dir = await mkdtempDisposable(join(tmpdir(), 'instagram-load-'));
  const pinned = { pk: '4000000', takenAt: day - 900 * 86_400, pinned: true };
  const profile = hive([pinned, ...posts(400)]);
  using _wire = instagram({ profiles: [profile], following: [] });
  const run = await pipeline(
    await InstagramWebSource.connect({ profileIds: ['44555906095'] }),
    dir.path,
  );
  await run.run();

  const published = Array.from({ length: 40 }, (_, index) => ({
    pk: String(7_000_039 - index),
    takenAt: day + (40 - index) * 3600,
  }));
  profile.posts = [pinned, ...published, ...profile.posts.slice(1)];
  await run.run();

  const loaded = ids(dir.path, 'SELECT id FROM posts');
  assert.deepEqual(
    published.filter(({ pk }) => !loaded.includes(pk)).map(({ pk }) => pk),
    [],
  );
  assert.deepEqual(
    rows(dir.path, `SELECT pinned FROM posts WHERE id = '4000000'`),
    [{ pinned: 1 }],
  );
});

test('an edited caption updates its post when the scan reads the post again', async () => {
  await using _mac = await signedInMac();
  await using dir = await mkdtempDisposable(join(tmpdir(), 'instagram-load-'));
  const profile = hive(posts(5));
  using _wire = instagram({ profiles: [profile], following: [] });
  const run = await pipeline(
    await InstagramWebSource.connect({ profileIds: ['44555906095'] }),
    dir.path,
  );
  await run.run();
  const edited = profile.posts[2];
  assert.ok(edited !== undefined);

  profile.posts = profile.posts.map((post) =>
    post === edited ? { ...post, caption: 'Class moved to 18:00' } : post,
  );
  const second = counts(await run.run());

  assert.deepEqual(second.posts, { count: 1, deleted: 0 });
  assert.deepEqual(
    rows(dir.path, `SELECT caption FROM posts WHERE id = '${edited.pk}'`),
    [{ caption: 'Class moved to 18:00' }],
  );
});

test('a date range ends the walk at the first post older than its start, so a narrowed import reads only the pages it needs, and leaves out a post at its end', async () => {
  await using _mac = await signedInMac();
  await using dir = await mkdtempDisposable(join(tmpdir(), 'instagram-load-'));
  using wire = instagram({ profiles: [hive(posts(400))], following: [] });
  const startAt = new Date((day - 19 * 86_400) * 1000).toISOString();
  // An import scope's end is exclusive: a post at that instant is out.
  const endAt = new Date((day - 2 * 86_400) * 1000).toISOString();
  const run = await pipeline(
    await InstagramWebSource.connect({
      profileIds: ['44555906095'],
      startAt,
      endAt,
    }),
    dir.path,
  );

  await run.run();
  const first = timelinePages(wire.calls);
  wire.calls.length = 0;
  await run.run();

  assert.deepEqual(first, [null]);
  assert.deepEqual(timelinePages(wire.calls), [null]);
  assert.equal(rows(dir.path, 'SELECT count(*) AS n FROM posts')[0]?.n, 17);
  assert.equal(
    rows(
      dir.path,
      `SELECT count(*) AS n FROM posts WHERE "postedAt" < '${startAt}' OR "postedAt" >= '${endAt}'`,
    )[0]?.n,
    0,
  );
});

test('a scope narrowed to one profile reads that profile’s lists and nothing of another', async () => {
  await using _mac = await signedInMac();
  await using dir = await mkdtempDisposable(join(tmpdir(), 'instagram-load-'));
  const other: Profile = {
    pk: '555',
    username: 'propertyplus.jo',
    posts: posts(3, 1000),
  };
  using wire = instagram({
    profiles: [hive(posts(3)), other],
    following: [
      { pk: '44555906095', username: 'hivefitnationgym' },
      { pk: '555', username: 'propertyplus.jo' },
    ],
  });
  const run = await pipeline(
    await InstagramWebSource.connect({ profileIds: ['44555906095'] }),
    dir.path,
  );

  await run.run();

  for (const table of ['profiles', 'posts', 'media'])
    assert.deepEqual(
      rows(dir.path, `SELECT DISTINCT "profileId" AS id FROM ${table}`),
      [{ id: '44555906095' }],
      table,
    );
  assert.deepEqual(
    wire.calls.filter(({ variables }) =>
      Object.values(variables).some(
        (value) => value === '555' || value === 'propertyplus.jo',
      ),
    ),
    [],
  );
});

test('a second run with no change upstream writes nothing and downloads no image', async () => {
  await using _mac = await signedInMac();
  await using dir = await mkdtempDisposable(join(tmpdir(), 'instagram-load-'));
  const profile: Profile = {
    ...hive([{ pk: '9', takenAt: day, slides: 3 }, ...posts(4)]),
    stories: [
      {
        pk: '91',
        takenAt: day,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
    ],
    highlights: [
      {
        id: '81',
        title: 'Classes',
        items: [
          { pk: '82', takenAt: day - 9 * 86_400, expiresAt: day - 8 * 86_400 },
        ],
      },
    ],
  };
  using wire = instagram({
    profiles: [profile],
    following: [{ pk: '44555906095', username: 'hivefitnationgym' }],
  });
  const source = await InstagramWebSource.connect({
    profileIds: ['44555906095'],
  });
  const run = await pipeline(source, dir.path);
  const first = counts(await run.run());
  const downloaded = [...wire.downloads].sort();
  wire.downloads.length = 0;
  const { streams } = await source.discover();

  const second = counts(await run.run());

  assert.deepEqual(
    Object.fromEntries(
      Object.entries(first)
        .filter(([, { count }]) => count > 0)
        .map(([name, { count }]) => [name, count]),
    ),
    {
      following: 1,
      profiles: 1,
      posts: 5,
      media: 7,
      stories: 1,
      highlights: 1,
      highlight_items: 1,
    },
  );
  assert.equal(downloaded.length, 9);
  assert.deepEqual(
    second,
    Object.fromEntries(
      streams.map(({ name }) => [name, { count: 0, deleted: 0 }]),
    ),
  );
  assert.deepEqual(wire.downloads, []);
});

test(
  'a page cursor Instagram gives twice fails the profile’s read instead of reading the same pages forever',
  { timeout: 30_000 },
  async () => {
    await using _mac = await signedInMac();
    await using dir = await mkdtempDisposable(
      join(tmpdir(), 'instagram-load-'),
    );
    // Newer posts with smaller ids than the page above them, which Instagram
    // never sends: the page after the first one starts at the top again.
    const profile = hive(
      Array.from({ length: 40 }, (_, index) => ({
        pk: String(8_000_000 + index),
        takenAt: day - index * 3600,
      })),
    );
    using _wire = instagram({ profiles: [profile], following: [] });
    const run = await pipeline(
      await InstagramWebSource.connect({ profileIds: ['44555906095'] }),
      dir.path,
    );

    const failed = await failedRun(run.run());

    assert.match(
      String(failed.posts?.[0]?.error),
      /gave the posts page cursor \d+ twice in one read/,
    );
  },
);

// Each stored file of a table, by key, as text.
async function storedFiles(directory: string, sql: string) {
  return Object.fromEntries(
    await Promise.all(
      rows(directory, sql).map(async ({ key, attachmentRef }) => [
        String(key),
        typeof attachmentRef === 'string'
          ? await readFile(attachmentRef, 'utf8')
          : null,
      ]),
    ),
  );
}

test('every slide of a carousel, of a repost and of a tagged post is a media row with its image stored, joined to its post', async () => {
  await using _mac = await signedInMac();
  await using dir = await mkdtempDisposable(join(tmpdir(), 'instagram-load-'));
  const timetable = {
    pk: '4000396333676604349',
    takenAt: day,
    slides: 11,
    caption: 'Our October schedules are now available.',
  };
  using _wire = instagram({
    profiles: [
      {
        ...hive([timetable, { pk: '41', takenAt: day - 86_400 }]),
        reposts: [{ pk: '51', takenAt: day, slides: 3, owner: 'hivekids' }],
        tagged: [{ pk: '61', takenAt: day, slides: 2, owner: 'amman.runners' }],
      },
    ],
    following: [],
  });

  await (
    await pipeline(
      await InstagramWebSource.connect({ profileIds: ['44555906095'] }),
      dir.path,
    )
  ).run();

  assert.deepEqual(
    rows(
      dir.path,
      `SELECT list, count(*) AS n FROM media GROUP BY list ORDER BY list`,
    ),
    [
      { list: 'posts', n: 12 },
      { list: 'reposts', n: 3 },
      { list: 'tagged', n: 2 },
    ],
  );
  assert.deepEqual(
    rows(
      dir.path,
      `SELECT p.caption, count(*) AS n FROM media m JOIN posts p ON p.id = m."postId" AND p."profileId" = m."profileId" WHERE m.list = 'posts' GROUP BY p.id ORDER BY n DESC`,
    ),
    [
      { caption: 'Our October schedules are now available.', n: 11 },
      { caption: 'Post 41', n: 1 },
    ],
  );
  const files = await storedFiles(
    dir.path,
    `SELECT id AS key, "attachmentRef" FROM media WHERE "postId" = '${timetable.pk}' ORDER BY position`,
  );
  assert.deepEqual(
    files,
    Object.fromEntries(
      Array.from({ length: 11 }, (_, index) => [
        `${timetable.pk}0${index}`,
        bytesOf(`${timetable.pk}0${index}`),
      ]),
    ),
  );
  assert.deepEqual(rows(dir.path, `SELECT owner, slides FROM reposts`), [
    { owner: 'hivekids', slides: 3 },
  ]);
  assert.deepEqual(rows(dir.path, `SELECT owner, slides FROM tagged_posts`), [
    { owner: 'amman.runners', slides: 2 },
  ]);
});

test('a video post and a reel load their cover frame as the file, and no video is downloaded', async () => {
  await using _mac = await signedInMac();
  await using dir = await mkdtempDisposable(join(tmpdir(), 'instagram-load-'));
  using wire = instagram({
    profiles: [
      {
        ...hive([{ pk: '71', takenAt: day, video: true }]),
        reels: [{ pk: '72', takenAt: day }],
      },
    ],
    following: [],
  });

  await (
    await pipeline(
      await InstagramWebSource.connect({ profileIds: ['44555906095'] }),
      dir.path,
    )
  ).run();

  assert.deepEqual(
    rows(dir.path, `SELECT list, id, kind FROM media ORDER BY list`),
    [
      { list: 'posts', id: '71', kind: 'video' },
      { list: 'reels', id: '72', kind: 'video' },
    ],
  );
  assert.deepEqual(
    await storedFiles(
      dir.path,
      `SELECT id AS key, "attachmentRef" FROM media ORDER BY id`,
    ),
    {
      71: bytesOf('71'),
      72: bytesOf('72'),
    },
  );
  assert.deepEqual(wire.downloads.sort(), ['71', '72']);
});

test('a story that Instagram stopped showing keeps its row, and one the profile deleted before then is deleted', async () => {
  await using _mac = await signedInMac();
  await using dir = await mkdtempDisposable(join(tmpdir(), 'instagram-load-'));
  const now = Math.floor(Date.now() / 1000);
  const profile: Profile = {
    ...hive([]),
    stories: [
      // Expired by the second run, as a day-old story is.
      { pk: '91', takenAt: now - 86_400, expiresAt: now - 1 },
      { pk: '92', takenAt: now - 3600, expiresAt: now + 82_800 },
      { pk: '93', takenAt: now - 60, expiresAt: now + 86_340 },
    ],
  };
  using _wire = instagram({ profiles: [profile], following: [] });
  const run = await pipeline(
    await InstagramWebSource.connect({ profileIds: ['44555906095'] }),
    dir.path,
  );
  await run.run();

  profile.stories = [{ pk: '93', takenAt: now - 60, expiresAt: now + 86_340 }];
  const second = counts(await run.run());

  assert.deepEqual(second.stories, { count: 0, deleted: 1 });
  assert.deepEqual(ids(dir.path, 'SELECT id FROM stories ORDER BY id'), [
    '91',
    '93',
  ]);
  assert.deepEqual(
    await storedFiles(
      dir.path,
      `SELECT id AS key, "attachmentRef" FROM stories ORDER BY id`,
    ),
    {
      91: bytesOf('91'),
      93: bytesOf('93'),
    },
  );
});

test('highlights load with every story in them and its image, and a highlight the profile removed goes with its stories', async () => {
  await using _mac = await signedInMac();
  await using dir = await mkdtempDisposable(join(tmpdir(), 'instagram-load-'));
  const story = (pk: string) => ({
    pk,
    takenAt: day - 9 * 86_400,
    expiresAt: day - 8 * 86_400,
  });
  const profile: Profile = {
    ...hive([]),
    highlights: [
      { id: '81', title: 'Classes', items: [story('811'), story('812')] },
      ...Array.from({ length: 6 }, (_, index) => ({
        id: `8${index + 2}`,
        title: `H${index}`,
        items: [story(`8${index + 2}1`)],
      })),
    ],
  };
  using _wire = instagram({ profiles: [profile], following: [] });
  const run = await pipeline(
    await InstagramWebSource.connect({ profileIds: ['44555906095'] }),
    dir.path,
  );
  await run.run();
  const loaded = rows(dir.path, 'SELECT count(*) AS n FROM highlight_items')[0]
    ?.n;
  const files = await storedFiles(
    dir.path,
    `SELECT id AS key, "attachmentRef" FROM highlight_items WHERE "highlightId" = '81' ORDER BY id`,
  );

  profile.highlights = profile.highlights?.filter(({ id }) => id !== '81');
  await run.run();

  assert.equal(loaded, 8);
  assert.deepEqual(files, { 811: bytesOf('811'), 812: bytesOf('812') });
  assert.deepEqual(
    rows(dir.path, `SELECT count(*) AS n FROM highlights WHERE id = '81'`),
    [{ n: 0 }],
  );
  assert.deepEqual(
    rows(
      dir.path,
      `SELECT count(*) AS n FROM highlight_items WHERE "highlightId" = '81'`,
    ),
    [{ n: 0 }],
  );
  assert.equal(
    rows(dir.path, 'SELECT count(*) AS n FROM highlight_items')[0]?.n,
    6,
  );
});

test('comments load with their replies, are read again within a scan only when a post’s comment count changes, and a removed comment is deleted', async () => {
  await using _mac = await signedInMac();
  await using dir = await mkdtempDisposable(join(tmpdir(), 'instagram-load-'));
  const changed: Post = {
    pk: '9000001',
    takenAt: day + 2 * 86_400,
    comments: [
      {
        pk: '311',
        text: 'What time is BodyPump on Saturday?',
        replies: [{ pk: '3111', text: '06:30 with Hasan' }],
      },
      { pk: '312', text: 'Is Aqua open for women?' },
    ],
  };
  const unchanged: Post = {
    pk: '9000000',
    takenAt: day + 86_400,
    comments: [{ pk: '321', text: 'See you at 18:00' }],
  };
  // Longer than one run reads, so the second run is in the same scan.
  const profile = hive([changed, unchanged, ...posts(398)]);
  using wire = instagram({ profiles: [profile], following: [] });
  const run = await pipeline(
    await InstagramWebSource.connect({ profileIds: ['44555906095'] }),
    dir.path,
  );
  const reads = () =>
    wire.calls
      .filter(({ name }) => name === 'comments')
      .map(({ variables }) => variables.media);
  await run.run();
  const first = rows(
    dir.path,
    `SELECT id, "parentId", text, replies FROM comments ORDER BY id`,
  );
  const firstReads = reads();
  wire.calls.length = 0;

  profile.posts = [
    { ...changed, comments: changed.comments?.slice(0, 1) },
    ...profile.posts.slice(1),
  ];
  await run.run();

  assert.deepEqual(first, [
    {
      id: '311',
      parentId: null,
      text: 'What time is BodyPump on Saturday?',
      replies: 1,
    },
    { id: '3111', parentId: '311', text: '06:30 with Hasan', replies: null },
    { id: '312', parentId: null, text: 'Is Aqua open for women?', replies: 0 },
    { id: '321', parentId: null, text: 'See you at 18:00', replies: 0 },
  ]);
  assert.deepEqual(firstReads, ['9000001', '9000000']);
  assert.deepEqual(reads(), ['9000001']);
  assert.deepEqual(ids(dir.path, 'SELECT id FROM comments ORDER BY id'), [
    '311',
    '3111',
    '321',
  ]);
});

test('the reels tab, reposts and tagged posts load for the profile, page after page', async () => {
  await using _mac = await signedInMac();
  await using dir = await mkdtempDisposable(join(tmpdir(), 'instagram-load-'));
  const list = (count: number, from: number) =>
    Array.from({ length: count }, (_, index) => ({
      pk: String(from + count - index),
      takenAt: day - index * 3600,
    }));
  using _wire = instagram({
    profiles: [
      {
        ...hive(posts(2)),
        reels: [
          ...list(29, 200),
          { pk: '200', takenAt: day - 29 * 3600, plays: null },
        ],
        reposts: list(25, 300),
        tagged: list(14, 400),
      },
    ],
    following: [],
  });

  await (
    await pipeline(
      await InstagramWebSource.connect({ profileIds: ['44555906095'] }),
      dir.path,
    )
  ).run();

  assert.deepEqual(
    Object.fromEntries(
      ['reels', 'reposts', 'tagged_posts'].map((table) => [
        table,
        rows(dir.path, `SELECT count(*) AS n FROM ${table}`)[0]?.n,
      ]),
    ),
    { reels: 30, reposts: 25, tagged_posts: 14 },
  );
  assert.deepEqual(
    rows(
      dir.path,
      `SELECT id, url, plays FROM reels WHERE id IN ('229', '200') ORDER BY id`,
    ),
    [
      { id: '200', url: 'https://www.instagram.com/reel/R200/', plays: null },
      { id: '229', url: 'https://www.instagram.com/reel/R229/', plays: 120 },
    ],
  );
});

test('the accounts the browser’s account follows load across pages, and one it unfollows is deleted', async () => {
  await using _mac = await signedInMac();
  await using dir = await mkdtempDisposable(join(tmpdir(), 'instagram-load-'));
  const world: World = {
    profiles: [hive([])],
    following: Array.from({ length: 103 }, (_, index) => ({
      pk: String(10_000 + index),
      username: `account${index}`,
    })),
  };
  using _wire = instagram(world);
  const run = await pipeline(
    await InstagramWebSource.connect({ profileIds: ['44555906095'] }),
    dir.path,
  );
  await run.run();
  const loaded = rows(dir.path, 'SELECT count(*) AS n FROM following')[0]?.n;

  world.following = world.following.filter(({ pk }) => pk !== '10050');
  await run.run();

  assert.equal(loaded, 103);
  assert.equal(
    rows(dir.path, 'SELECT count(*) AS n FROM following')[0]?.n,
    102,
  );
  assert.deepEqual(
    rows(dir.path, `SELECT count(*) AS n FROM following WHERE id = '10050'`),
    [{ n: 0 }],
  );
});

test('a session Instagram no longer accepts fails as the user’s to fix, with the sign-in step, and keeps every row loaded', async () => {
  await using _mac = await signedInMac();
  await using dir = await mkdtempDisposable(join(tmpdir(), 'instagram-load-'));
  const world: World = { profiles: [hive(posts(5))], following: [] };
  using _wire = instagram(world);
  const run = await pipeline(
    await InstagramWebSource.connect({ profileIds: ['44555906095'] }),
    dir.path,
  );
  await run.run();

  world.signedOut = true;
  const failed = await failedRun(run.run());

  assert.equal(failed.posts?.[0]?.failureType, 'config');
  assert.match(
    String(failed.posts?.[0]?.error),
    /sign in to Instagram again in your browser/,
  );
  assert.equal(rows(dir.path, 'SELECT count(*) AS n FROM posts')[0]?.n, 5);
});

test('a Mac where no browser is signed in to Instagram fails as the user’s to fix, naming the browsers it checked', async () => {
  await using mac = await signedInMac();
  await using dir = await mkdtempDisposable(join(tmpdir(), 'instagram-load-'));
  using _wire = instagram({ profiles: [hive(posts(1))], following: [] });
  const source = await InstagramWebSource.connect({
    profileIds: ['44555906095'],
  });
  const run = await pipeline(source, dir.path);
  const cookies = join(
    mac.path,
    'Library/Application Support/Dia/User Data/Default/Cookies',
  );
  {
    using database = new DatabaseSync(cookies);
    database.exec(`DELETE FROM cookies WHERE name = 'sessionid'`);
  }

  const failed = await failedRun(run.run());

  assert.deepEqual(
    Object.values(failed).map((failures) => failures[0]?.failureType),
    Object.values(failed).map(() => 'config'),
  );
  assert.match(
    String(failed.posts?.[0]?.error),
    /No browser profile holds an unexpired sessionid cookie for www\.instagram\.com\. Sign in to www\.instagram\.com in Dia/,
  );
});

test(
  'a watch wakes every selected stream at once, then waits instead of asking Instagram again',
  { timeout: 30_000 },
  async () => {
    const source = await InstagramWebSource.connect({
      profileIds: ['44555906095'],
    });
    const { streams } = await source.discover();
    const watching = new AbortController();
    const watch = source.watch({ streams, signal: watching.signal });
    const checks = watch[Symbol.asyncIterator]();
    try {
      const first = await checks.next();
      const again = await Promise.race([
        checks.next().then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 300)),
      ]);

      assert.deepEqual(first.value, streams);
      assert.equal(again, false);
    } finally {
      watching.abort();
    }
  },
);

test('a comment Instagram lists twice in one answer loads once', async () => {
  await using _mac = await signedInMac();
  await using dir = await mkdtempDisposable(join(tmpdir(), 'instagram-load-'));
  // On 2026-10-15 Instagram answered one post's comments with 15 entries
  // and 8 distinct comments.
  const repeated: Comment = { pk: '18398660635134371', text: 'See you there' };
  using _wire = instagram({
    profiles: [
      hive([
        {
          pk: '31',
          takenAt: day,
          comments: [repeated, { pk: '311', text: 'Is Aqua open?' }, repeated],
        },
      ]),
    ],
    following: [],
  });

  await (
    await pipeline(
      await InstagramWebSource.connect({ profileIds: ['44555906095'] }),
      dir.path,
    )
  ).run();

  assert.deepEqual(ids(dir.path, 'SELECT id FROM comments ORDER BY id'), [
    '18398660635134371',
    '311',
  ]);
});
