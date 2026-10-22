import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';

import { Pipeline } from '@workspace/elt';
import { SQLiteSyncHistory } from '@workspace/elt-sqlite';
import { ScratchMac } from '@workspace/sdk-chromium-cookies/test';
import { MacOSDocumentParser } from '@workspace/source-apple-macos/macos-document-parser';

import InstagramConnector from './instagram-connector.ts';

// This package's folder, which holds its manifest.
const folder = fileURLToPath(new URL('..', import.meta.url));

function connector(): InstagramConnector {
  const { contextCompiler } = JSON.parse(
    readFileSync(join(folder, 'package.json'), 'utf8'),
  );
  // Instagram reads nothing through EventKit.
  return new InstagramConnector(
    {
      grantee: 'Codex',
      documentParser: new MacOSDocumentParser(),
      eventKitHelper: '',
    },
    { name: contextCompiler.name, title: contextCompiler.title, folder },
  );
}

const session = {
  sessionid: '1691%3Asession',
  csrftoken: 'csrf-token',
  ds_user_id: '1691',
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
    Object.entries(session).map(([name, value]) => ({
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

// A PNG of the given line of text, drawn by AppKit, or a blank one; copied
// from the Messages source's test.
const renderedText = (path: string, text: string | null) =>
  execFileSync('/usr/bin/osascript', [
    '-l',
    'JavaScript',
    '-e',
    `ObjC.import('AppKit');
    const image = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, 640, 160, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
    const context = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(image);
    $.NSGraphicsContext.saveGraphicsState;
    $.NSGraphicsContext.setCurrentContext(context);
    $.NSColor.whiteColor.setFill;
    $.NSRectFill($.NSMakeRect(0, 0, 640, 160));
    const text = ${JSON.stringify(text)};
    if (text !== null) {
      const attributes = $.NSMutableDictionary.alloc.init;
      attributes.setObjectForKey($.NSFont.systemFontOfSize(40), $.NSFontAttributeName);
      attributes.setObjectForKey($.NSColor.blackColor, $.NSForegroundColorAttributeName);
      $(text).drawAtPointWithAttributes($.NSMakePoint(20, 60), attributes);
    }
    context.flushGraphics;
    $.NSGraphicsContext.restoreGraphicsState;
    image.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $()).writeToFileAtomically(${JSON.stringify(path)}, true);`,
  ]);

const cdn = 'https://scontent.cdninstagram.com';
const imageOf = (id: string) => `${cdn}/v/t51.2885-15/${id}_n.jpg?oh=signature`;
const images = (id: string) => ({
  candidates: [{ url: imageOf(id), width: 640, height: 160 }],
});

const hive = { pk: '44555906095', username: 'hivefitnationgym' };
const tokens = `<html><script>s.handle({"define":[["DTSGInitialData",[],{"token":"dtsg-token"},258],["LSD",[],{"token":"lsd-token"},323]]})</script></html>`;

/**
 * instagram.com and its image CDN, stubbed below fetch with msw, for a
 * signed-in session that follows Hive and one other account: Hive's grid
 * holds one carousel whose slides are the images given. Lists Hive does not
 * have answer empty, as Instagram answers them; anything else fails the test.
 */
function instagram(slides: ReadonlyMap<string, Buffer>) {
  const page = (edges: unknown[]) => ({
    edges,
    page_info: { end_cursor: null, has_next_page: false },
  });
  const carousel = {
    pk: '4000396333676604349',
    code: 'DeEQ0U9kau9',
    taken_at: 1791104426,
    media_type: 8,
    product_type: 'carousel_container',
    image_versions2: images([...slides.keys()][0] ?? ''),
    video_versions: null,
    accessibility_caption: null,
    caption: {
      text: 'Our October schedules are now available.',
      created_at: 1791104429,
    },
    caption_is_edited: false,
    like_count: 54,
    comment_count: 0,
    like_and_view_counts_disabled: false,
    timeline_pinned_user_ids: [hive.pk],
    user: hive,
    coauthor_producers: [],
    usertags: null,
    location: null,
    carousel_media: [...slides.keys()].map((id) => ({
      pk: id,
      media_type: 1,
      image_versions2: images(id),
      video_versions: null,
      accessibility_caption: null,
    })),
  };
  const answers: Record<
    string,
    (variables: Record<string, unknown>) => unknown
  > = {
    PolarisProfilePageContentQuery: () => ({
      data: {
        user: {
          ...hive,
          full_name: 'Hive Fit Nation',
          biography: '',
          external_url: null,
          bio_links: [],
          category: 'Gym/Physical Fitness Center',
          is_private: false,
          is_verified: false,
          is_business: true,
          follower_count: 9100,
          following_count: 3,
          media_count: 1,
          total_clips_count: 0,
          city_name: 'Amman',
          address_street: null,
          hd_profile_pic_url_info: { url: imageOf('avatar') },
        },
      },
    }),
    PolarisProfilePostsTabContentQuery_connection: () => ({
      data: {
        xdt_api__v1__feed__user_timeline_graphql_connection: page([
          { node: carousel },
        ]),
      },
    }),
    PolarisProfileReelsTabContentQuery_connection: () => ({
      data: { fetch__XDTUserDict: { clips_connection: page([]) } },
    }),
    PolarisProfileRepostsTabContentQuery: () => ({
      data: {
        fetch__XDTUserDict: {
          user_reposts_timeline: {
            repost_grid_items: [],
            repost_more_available: false,
            repost_next_max_id: null,
          },
        },
      },
    }),
    PolarisProfileTaggedTabContentQuery_connection: () => ({
      data: { xdt_api__v1__usertags__user_id__feed_connection: page([]) },
    }),
    PolarisProfileStoryHighlightsTrayContentQuery: () => ({
      data: { highlights: { edges: [] } },
    }),
    PolarisStoriesV3HighlightsPageQuery: () => ({
      data: { xdt_api__v1__feed__reels_media__connection: page([]) },
    }),
  };
  const signed = (request: Request) =>
    (request.headers.get('cookie') ?? '').includes(
      `sessionid=${session.sessionid}`,
    );
  const server = setupServer(
    http.get('https://www.instagram.com/', ({ request }) =>
      signed(request)
        ? new HttpResponse(tokens, { headers: { 'content-type': 'text/html' } })
        : new HttpResponse(null, { status: 403 }),
    ),
    http.get(
      `https://www.instagram.com/api/v1/friendships/${session.ds_user_id}/following/`,
      ({ request }) =>
        signed(request)
          ? Response.json({
              users: [
                {
                  ...hive,
                  full_name: 'Hive Fit Nation',
                  is_private: false,
                  is_verified: false,
                  profile_pic_url: imageOf('avatar'),
                },
                {
                  pk: '555',
                  username: 'propertyplus.jo',
                  full_name: '',
                  is_private: false,
                  is_verified: false,
                  profile_pic_url: imageOf('pp'),
                },
              ],
              has_more: false,
              status: 'ok',
            })
          : new HttpResponse(null, { status: 403 }),
    ),
    http.post(
      'https://www.instagram.com/graphql/query',
      async ({ request }) => {
        const form = new URLSearchParams(await request.text());
        const answer = answers[form.get('fb_api_req_friendly_name') ?? ''];
        if (
          !signed(request) ||
          form.get('fb_dtsg') !== 'dtsg-token' ||
          answer === undefined
        )
          return new HttpResponse(null, { status: 403 });
        return Response.json(answer(JSON.parse(form.get('variables') ?? '{}')));
      },
    ),
    http.get(`${cdn}/*`, ({ request }) => {
      const id = /\/([^/]+)_n\.jpg$/.exec(new URL(request.url).pathname)?.[1];
      const bytes = id === undefined ? undefined : slides.get(id);
      return bytes === undefined
        ? new HttpResponse(null, { status: 404 })
        : new HttpResponse(bytes, { headers: { 'content-type': 'image/png' } });
    }),
  );
  server.listen({ onUnhandledRequest: 'error' });
  return { [Symbol.dispose]: () => server.close() };
}

test('setup offers the accounts the browser’s Instagram account follows, by username and name', async () => {
  await using _mac = await signedInMac();
  using _wire = instagram(new Map());

  const [profiles] = await connector().listChoices();

  assert.deepEqual(profiles?.options, [
    { id: '44555906095', label: 'hivefitnationgym (Hive Fit Nation)' },
    { id: '555', label: 'propertyplus.jo' },
  ]);
});

test('an import that keeps attachments, as setup does by default, makes the text on a timetable slide searchable', async () => {
  await using mac = await signedInMac();
  const slides = new Map<string, Buffer>();
  for (const [id, text] of [
    ['40003963336766043490', 'BodyPump 06:30 Hasan'],
    ['40003963336766043491', null],
  ] as const) {
    const path = join(mac.path, `${id}.png`);
    renderedText(path, text);
    slides.set(id, readFileSync(path));
  }
  using _wire = instagram(slides);
  await using imports = await mkdtempDisposable(
    join(tmpdir(), 'instagram-import-'),
  );
  const instagramConnector = connector();
  const { connection, text, destination } = await instagramConnector.connection(
    imports.path,
    {
      connector: instagramConnector.name,
      scope: { collectionIds: [hive.pk] },
      includeAttachments: true,
    },
  );
  const history = new SQLiteSyncHistory();
  await history.install([destination]);

  await new Pipeline({ history, connections: [connection] }).run();
  await text?.update(new AbortController().signal);

  using database = new DatabaseSync(join(imports.path, 'data.sqlite'), {
    readOnly: true,
  });
  const found = database
    .prepare(
      `SELECT p.code, m.position, t.status, t.content
       FROM media m
       JOIN posts p ON p.id = m."postId" AND p."profileId" = m."profileId"
       JOIN attachment_text t ON t.ref = m."attachmentRef"
       ORDER BY m.position`,
    )
    .all()
    .map((row) => ({ ...row }));
  assert.equal(found.length, 2);
  assert.equal(found[0]?.code, 'DeEQ0U9kau9');
  assert.equal(found[0]?.status, 'parsed');
  assert.match(String(found[0]?.content), /BodyPump 06:30 Hasan/);
  assert.equal(found[1]?.status, 'no_text');
});
