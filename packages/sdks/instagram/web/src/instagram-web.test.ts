import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';

import {
  InstagramLoginError,
  InstagramQueryError,
  InstagramRateLimitError,
  InstagramWeb,
} from './index.ts';

const session = {
  cookies: new Map([
    ['sessionid', '1691%3Asession'],
    ['csrftoken', 'csrf-token'],
    ['ds_user_id', '1691'],
  ]),
};

// The two tokens a signed-in instagram.com page carries, as its server-side
// rendered script lists them.
const page = `<!DOCTYPE html><html><body><script>requireLazy(["ServerJS"],function(s){s.handle({"define":[["DTSGInitialData",[],{"token":"dtsg-token"},258],["LSD",[],{"token":"lsd-token"},323]]})});</script></body></html>`;

type Call = {
  readonly path: string;
  readonly query: string;
  readonly name: string | null;
};

/**
 * Instagram's side of the wire for one test, stubbed below fetch with msw:
 * the home page, and each API call answered by `api` only when it carries
 * what a signed-in browser sends, the session cookie, the CSRF header and,
 * for a GraphQL query, both page tokens. Instagram refuses anything else
 * with 403, and any other host fails the test.
 */
function instagram(api: (call: Call) => Response) {
  const calls: Call[] = [];
  const signed = (request: Request) => {
    const cookie = request.headers.get('cookie') ?? '';
    return (
      cookie.includes('sessionid=1691%3Asession') &&
      cookie.includes('csrftoken=csrf-token')
    );
  };
  const server = setupServer(
    http.get('https://www.instagram.com/', ({ request }) =>
      signed(request)
        ? new HttpResponse(page, { headers: { 'content-type': 'text/html' } })
        : new HttpResponse(null, { status: 403 }),
    ),
    http.all('https://www.instagram.com/*', async ({ request }) => {
      const url = new URL(request.url);
      const form =
        request.method === 'POST'
          ? new URLSearchParams(await request.text())
          : new URLSearchParams();
      const graphql = url.pathname === '/graphql/query';
      if (
        !signed(request) ||
        request.headers.get('x-csrftoken') !== 'csrf-token' ||
        (graphql &&
          (form.get('fb_dtsg') !== 'dtsg-token' ||
            form.get('lsd') !== 'lsd-token'))
      )
        return new HttpResponse(null, { status: 403 });
      const call = {
        path: url.pathname,
        query: url.search,
        name: form.get('fb_api_req_friendly_name'),
      };
      calls.push(call);
      return api(call);
    }),
  );
  server.listen({ onUnhandledRequest: 'error' });
  return { calls, [Symbol.dispose]: () => server.close() };
}

// What instagram.com answers a signed-out GraphQL query for stories: its
// web page, not JSON.
const webPage = () =>
  new HttpResponse('<!DOCTYPE html><html lang="en"><head></head></html>', {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });

test('a GraphQL answer sent as text/javascript, as Instagram sends one to a signed-in session, is read', async () => {
  // The content type a signed-in session got from /graphql/query on 2026-10-15.
  using _ = instagram(
    () =>
      new HttpResponse(
        JSON.stringify({
          data: {
            highlights: {
              edges: [
                {
                  node: {
                    id: 'highlight:1',
                    title: 'Classes',
                    cover_media: {
                      cropped_image_version: {
                        url: 'https://scontent.cdninstagram.com/v/c.jpg',
                      },
                    },
                  },
                },
              ],
            },
          },
        }),
        { headers: { 'content-type': 'text/javascript; charset=utf-8' } },
      ),
  );
  const web = await InstagramWeb.open(session);

  const highlights = await web.highlights('44555906095');

  assert.deepEqual(
    highlights.map(({ title }) => title),
    ['Classes'],
  );
});

// Shapes the live sync met on 2026-10-15 that the first schemas refused.
test('a reel whose play count Instagram leaves out is read with no count', async () => {
  using _ = instagram(() =>
    Response.json({
      data: {
        fetch__XDTUserDict: {
          clips_connection: {
            edges: [
              {
                node: {
                  media: {
                    pk: '1',
                    code: 'R1',
                    media_type: 2,
                    product_type: 'clips',
                    play_count: null,
                    like_count: 4,
                    comment_count: 0,
                    clips_tab_pinned_user_ids: [],
                    user: { pk: '44555906095', username: 'hivefitnationgym' },
                    image_versions2: {
                      candidates: [
                        {
                          url: 'https://scontent.cdninstagram.com/v/i.jpg',
                          width: 1080,
                          height: 1350,
                        },
                      ],
                    },
                  },
                },
              },
            ],
            page_info: { end_cursor: null, has_next_page: false },
          },
        },
      },
    }),
  );
  const web = await InstagramWeb.open(session);

  const page = await web.reels('44555906095', null);

  assert.deepEqual(
    page.items.map(({ play_count }) => play_count),
    [null],
  );
});

test('a repost and a tagged post whose caption has no date are read', async () => {
  const post = {
    pk: '2',
    code: 'P2',
    product_type: 'feed',
    caption: { text: 'Swim. Recharge. Repeat.' },
    like_count: 3,
    comment_count: 0,
    user: { pk: '777', username: 'hivekids' },
    media_type: 1,
    image_versions2: {
      candidates: [
        {
          url: 'https://scontent.cdninstagram.com/v/i.jpg',
          width: 1080,
          height: 1350,
        },
      ],
    },
    carousel_media: null,
  };
  using _ = instagram(({ name }) =>
    Response.json(
      name === 'PolarisProfileRepostsTabContentQuery'
        ? {
            data: {
              fetch__XDTUserDict: {
                user_reposts_timeline: {
                  repost_grid_items: [{ media: post }],
                  repost_more_available: false,
                  repost_next_max_id: null,
                },
              },
            },
          }
        : {
            data: {
              xdt_api__v1__usertags__user_id__feed_connection: {
                edges: [{ node: post }],
                page_info: { end_cursor: null, has_next_page: false },
              },
            },
          },
    ),
  );
  const web = await InstagramWeb.open(session);

  const reposts = await web.reposts('44555906095', null);
  const tagged = await web.tagged('44555906095', null);

  assert.deepEqual(
    [...reposts.items, ...tagged.items].map(({ caption }) => caption?.text),
    ['Swim. Recharge. Repeat.', 'Swim. Recharge. Repeat.'],
  );
});

test('a story whose video renditions carry no size is read', async () => {
  using _ = instagram(() =>
    Response.json({
      data: {
        xdt_api__v1__feed__reels_media__connection: {
          edges: [
            {
              node: {
                id: '44555906095',
                items: [
                  {
                    pk: '3',
                    taken_at: 1791100000,
                    expiring_at: 1791186400,
                    media_type: 2,
                    product_type: 'story',
                    image_versions2: {
                      candidates: [
                        {
                          url: 'https://scontent.cdninstagram.com/v/i.jpg',
                          width: 1080,
                          height: 1350,
                        },
                      ],
                    },
                    video_versions: [
                      {
                        url: 'https://scontent.cdninstagram.com/o1/v/s.mp4',
                        type: 101,
                      },
                    ],
                    accessibility_caption: null,
                  },
                ],
              },
            },
          ],
          page_info: { end_cursor: null, has_next_page: false },
        },
      },
    }),
  );
  const web = await InstagramWeb.open(session);

  const stories = await web.stories('44555906095');

  assert.deepEqual(
    stories.map(({ pk }) => pk),
    ['3'],
  );
});

test('a GraphQL query answered with a web page, as Instagram answers a signed-out session, fails as a lost login', async () => {
  using _ = instagram(() => webPage());
  const web = await InstagramWeb.open(session);

  await assert.rejects(
    web.stories('44555906095'),
    (error) =>
      error instanceof InstagramLoginError &&
      /sign in to Instagram again/.test(error.message),
  );
});

test('a REST call that Instagram redirects to its login page fails as a lost login', async () => {
  using _ = instagram(
    ({ path }) =>
      new HttpResponse(null, {
        status: 302,
        headers: {
          location: `https://www.instagram.com/accounts/login/?next=${encodeURIComponent(path)}`,
        },
      }),
  );
  const web = await InstagramWeb.open(session);

  await assert.rejects(
    web.comments('4000396333676604349', null),
    InstagramLoginError,
  );
});

test('a 429 fails at once as a rate limit, and the request is not sent again', async () => {
  using wire = instagram(
    () =>
      new HttpResponse(
        '<!DOCTYPE html><html><body>Please wait a few minutes before you try again.</body></html>',
        { status: 429, headers: { 'content-type': 'text/html' } },
      ),
  );
  const web = await InstagramWeb.open(session);

  await assert.rejects(
    web.posts('hivefitnationgym', null),
    InstagramRateLimitError,
  );
  assert.equal(wire.calls.length, 1);
});

test('a 401 that asks to wait a few minutes fails as a rate limit, not a lost login', async () => {
  // Verbatim, as Instagram answered a busy client on 2026-10-15.
  using _ = instagram(() =>
    Response.json(
      {
        message: 'Please wait a few minutes before you try again.',
        require_login: true,
        igweb_rollout: true,
        status: 'fail',
      },
      { status: 401 },
    ),
  );
  const web = await InstagramWeb.open(session);

  await assert.rejects(
    web.posts('hivefitnationgym', null),
    InstagramRateLimitError,
  );
});

test('a query Instagram refuses fails naming the query', async () => {
  // Verbatim, as Instagram refused a persisted query on 2026-10-15.
  using _ = instagram(() =>
    Response.json(
      {
        message: 'invalid request',
        errors: [
          {
            message: 'execution error',
            code: 1675002,
            summary: 'Incorrect Query',
            description: 'The query provided was invalid.',
            extensions: {},
            severity: 'CRITICAL',
          },
        ],
        status: 'fail',
      },
      { status: 400 },
    ),
  );
  const web = await InstagramWeb.open(session);

  await assert.rejects(
    web.tagged('44555906095', null),
    (error) =>
      error instanceof InstagramQueryError &&
      /PolarisProfileTaggedTabContentQuery_connection/.test(error.message) &&
      /Incorrect Query/.test(error.message),
  );
});

test('an answer missing a field the SDK reads fails naming the query and the field', async () => {
  using _ = instagram(() =>
    Response.json({
      data: {
        xdt_api__v1__feed__user_timeline_graphql_connection: {
          edges: [
            {
              // A grid photo as Instagram sends it, but without its code.
              node: {
                pk: '4000396333676604349',
                id: '4000396333676604349_44555906095',
                taken_at: 1791104426,
                media_type: 1,
                product_type: 'feed',
                image_versions2: {
                  candidates: [
                    {
                      url: 'https://scontent.cdninstagram.com/v/photo.jpg',
                      width: 1080,
                      height: 1350,
                    },
                  ],
                },
                video_versions: null,
                accessibility_caption: null,
                caption: {
                  text: 'Our October schedules',
                  created_at: 1791104429,
                },
                caption_is_edited: false,
                like_count: 54,
                comment_count: 0,
                like_and_view_counts_disabled: false,
                timeline_pinned_user_ids: [],
                user: { pk: '44555906095', username: 'hivefitnationgym' },
                coauthor_producers: [],
                usertags: null,
                carousel_media: null,
              },
            },
          ],
          page_info: {
            end_cursor: null,
            has_next_page: false,
            has_previous_page: false,
            start_cursor: null,
          },
        },
      },
    }),
  );
  const web = await InstagramWeb.open(session);

  await assert.rejects(
    web.posts('hivefitnationgym', null),
    (error) =>
      error instanceof InstagramQueryError &&
      /PolarisProfilePostsTabContentQuery_connection/.test(error.message) &&
      /node\.code: Invalid input/.test(error.message),
  );
});
