import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

import type { z } from 'zod';

import {
  InstagramLoginError,
  InstagramQueryError,
  InstagramRateLimitError,
} from './errors.ts';
import {
  type PersistedQuery,
  highlightItemsQuery,
  highlightsQuery,
  moreRepostsQuery,
  postsQuery,
  profileQuery,
  reelsQuery,
  repostsQuery,
  storiesQuery,
  taggedQuery,
  variablesOf,
} from './queries.ts';
import {
  type Comment,
  type FollowedAccount,
  type Highlight,
  type ListMedia,
  type Profile,
  type ReelMedia,
  type StoryItem,
  type TimelineMedia,
  type TopComment,
  commentsResponse,
  followingResponse,
  highlightsResponse,
  postsResponse,
  profileResponse,
  reelsMediaResponse,
  reelsResponse,
  repliesResponse,
  repostsResponse,
  taggedResponse,
} from './schemas.ts';

const origin = 'https://www.instagram.com';
// The id instagram.com's web client sends on every API call.
const webAppId = '936619743392459';
// Instagram answers some calls only to a browser.
const userAgent =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

// A signed-in instagram.com session: the cookies a browser sends to it, with
// sessionid, csrftoken and ds_user_id among them.
export type InstagramSession = {
  readonly cookies: ReadonlyMap<string, string>;
};

// One page of a list, and the cursor of the next page, null on the last.
export type Page<Item> = {
  readonly items: readonly Item[];
  readonly next: string | null;
};

export type HighlightItems = {
  readonly id: string;
  readonly items: readonly StoryItem[];
};

// instagram.com's web API as its own web client calls it: persisted GraphQL
// queries and a few REST calls, with the session's cookies and the tokens
// its page carries.
export class InstagramWeb {
  // The signed-in account's id.
  readonly viewerId: string;
  readonly #cookie: string;
  readonly #csrf: string;
  readonly #dtsg: string;
  readonly #lsd: string;

  private constructor(
    viewerId: string,
    cookie: string,
    csrf: string,
    tokens: { dtsg: string; lsd: string },
  ) {
    this.viewerId = viewerId;
    this.#cookie = cookie;
    this.#csrf = csrf;
    this.#dtsg = tokens.dtsg;
    this.#lsd = tokens.lsd;
  }

  // Reads the tokens a signed-in page carries; a page without them is the
  // page Instagram shows a browser that is not signed in.
  static async open(
    { cookies }: InstagramSession,
    signal?: AbortSignal,
  ): Promise<InstagramWeb> {
    const viewerId = cookies.get('ds_user_id');
    const csrf = cookies.get('csrftoken');
    if (
      !cookies.has('sessionid') ||
      viewerId === undefined ||
      csrf === undefined
    )
      throw new InstagramLoginError('the session');
    const cookie = [...cookies]
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
    const response = await send(
      'its home page',
      '/',
      { headers: { cookie, 'user-agent': userAgent, accept: 'text/html' } },
      signal,
    );
    const html = await response.text();
    const dtsg = /\["DTSGInitialData",\[\],\{"token":"([^"]+)"/.exec(html)?.[1];
    const lsd = /\["LSD",\[\],\{"token":"([^"]+)"/.exec(html)?.[1];
    if (dtsg === undefined || lsd === undefined)
      throw new InstagramLoginError('its home page');
    return new InstagramWeb(viewerId, cookie, csrf, { dtsg, lsd });
  }

  // The accounts the signed-in account follows, 50 at a time.
  async following(
    maxId: string | null,
    signal?: AbortSignal,
  ): Promise<Page<FollowedAccount>> {
    const page = await this.#rest(
      'the accounts it follows',
      `/api/v1/friendships/${this.viewerId}/following/?count=50${maxId === null ? '' : `&max_id=${encodeURIComponent(maxId)}`}`,
      followingResponse,
      signal,
    );
    return {
      items: page.users,
      next: page.has_more ? (page.next_max_id ?? null) : null,
    };
  }

  async profile(userId: string, signal?: AbortSignal): Promise<Profile> {
    const answer = await this.#graphql(
      profileQuery,
      { enable_integrity_filters: true, id: userId },
      profileResponse,
      signal,
    );
    return answer.data.user;
  }

  // The profile's grid, newest first after the pinned posts, 33 at a time,
  // the most Instagram gives for one page.
  async posts(
    username: string,
    after: string | null,
    signal?: AbortSignal,
  ): Promise<Page<TimelineMedia>> {
    const data = {
      count: 33,
      include_reel_media_seen_timestamp: true,
      include_relationship_info: true,
      latest_besties_reel_media: true,
      latest_reel_media: true,
    };
    const answer = await this.#graphql(
      postsQuery,
      {
        after,
        before: null,
        data,
        first: 33,
        include_multi_captions: true,
        last: null,
        username,
      },
      postsResponse,
      signal,
    );
    const { edges, page_info } =
      answer.data.xdt_api__v1__feed__user_timeline_graphql_connection;
    return { items: edges.map(({ node }) => node), next: nextOf(page_info) };
  }

  // The profile's reels tab, 12 at a time.
  async reels(
    userId: string,
    after: string | null,
    signal?: AbortSignal,
  ): Promise<Page<ReelMedia>> {
    const answer = await this.#graphql(
      reelsQuery,
      {
        after,
        data: {
          include_feed_video: true,
          page_size: 12,
          target_user_id: userId,
        },
        first: 12,
        id: userId,
      },
      reelsResponse,
      signal,
    );
    const { edges, page_info } =
      answer.data.fetch__XDTUserDict.clips_connection;
    return {
      items: edges.map(({ node }) => node.media),
      next: nextOf(page_info),
    };
  }

  // The posts of other accounts the profile reposted, 12 at a time.
  async reposts(
    userId: string,
    maxId: string | null,
    signal?: AbortSignal,
  ): Promise<Page<ListMedia>> {
    const answer =
      maxId === null
        ? await this.#graphql(
            repostsQuery,
            { user_id: userId },
            repostsResponse,
            signal,
          )
        : await this.#graphql(
            moreRepostsQuery,
            { id: userId, max_id: maxId },
            repostsResponse,
            signal,
          );
    const timeline = answer.data.fetch__XDTUserDict.user_reposts_timeline;
    return {
      items: timeline.repost_grid_items.map(({ media }) => media),
      next: timeline.repost_more_available ? timeline.repost_next_max_id : null,
    };
  }

  // Posts of other accounts that tag the profile, 12 at a time.
  async tagged(
    userId: string,
    after: string | null,
    signal?: AbortSignal,
  ): Promise<Page<ListMedia>> {
    const answer = await this.#graphql(
      taggedQuery,
      {
        after,
        before: null,
        count: 12,
        first: 12,
        last: null,
        user_id: userId,
      },
      taggedResponse,
      signal,
    );
    const { edges, page_info } =
      answer.data.xdt_api__v1__usertags__user_id__feed_connection;
    return { items: edges.map(({ node }) => node), next: nextOf(page_info) };
  }

  async highlights(userId: string, signal?: AbortSignal): Promise<Highlight[]> {
    const answer = await this.#graphql(
      highlightsQuery,
      { user_id: userId },
      highlightsResponse,
      signal,
    );
    return answer.data.highlights.edges.map(({ node }) => node);
  }

  // The stories the profile posted in the last day.
  async stories(userId: string, signal?: AbortSignal): Promise<StoryItem[]> {
    const answer = await this.#graphql(
      storiesQuery,
      { first: 1, initial_reel_id: userId, last: null, reel_ids: [userId] },
      reelsMediaResponse,
      signal,
    );
    return answer.data.xdt_api__v1__feed__reels_media__connection.edges.flatMap(
      ({ node }) => node.items,
    );
  }

  // The items of highlights, a few highlights at a time; ids as the tray
  // lists them, such as highlight:18396646255144344.
  async highlightItems(
    ids: readonly string[],
    after: string | null,
    signal?: AbortSignal,
  ): Promise<Page<HighlightItems>> {
    const answer = await this.#graphql(
      highlightItemsQuery,
      {
        after,
        before: null,
        first: 5,
        initial_reel_id: ids[0],
        is_highlight: true,
        last: null,
        reel_ids: ids,
      },
      reelsMediaResponse,
      signal,
    );
    const { edges, page_info } =
      answer.data.xdt_api__v1__feed__reels_media__connection;
    return { items: edges.map(({ node }) => node), next: nextOf(page_info) };
  }

  // A post's comments, a page at a time, with how many replies each has.
  async comments(
    mediaId: string,
    minId: string | null,
    signal?: AbortSignal,
  ): Promise<Page<TopComment>> {
    const page = await this.#rest(
      'the comments of a post',
      `/api/v1/media/${mediaId}/comments/?can_support_threading=true&permalink_enabled=false${minId === null ? '' : `&min_id=${encodeURIComponent(minId)}`}`,
      commentsResponse,
      signal,
    );
    return {
      items: page.comments,
      next: page.has_more_comments ? (page.next_min_id ?? null) : null,
    };
  }

  // The replies to a comment, a page at a time.
  async replies(
    mediaId: string,
    commentId: string,
    cursor: string | null,
    signal?: AbortSignal,
  ): Promise<Page<Comment>> {
    const page = await this.#rest(
      'the replies to a comment',
      `/api/v1/media/${mediaId}/comments/${commentId}/child_comments/${cursor === null ? '' : `?max_id=${encodeURIComponent(cursor)}`}`,
      repliesResponse,
      signal,
    );
    return {
      items: page.child_comments,
      next: page.has_more_tail_child_comments
        ? (page.next_max_child_cursor ?? null)
        : null,
    };
  }

  // Saves an image or video from Instagram's CDN, whose URLs are signed and
  // need no session. False when the CDN answers 410 Gone: it no longer has
  // the file, though the answer that listed it is fresh.
  async download(
    url: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const response = await fetch(url, {
      headers: { 'user-agent': userAgent },
      signal,
    });
    if (response.status === 410) return false;
    if (response.status === 429)
      throw new InstagramRateLimitError('a download');
    if (!response.ok || response.body === null)
      throw new InstagramQueryError(
        'a download',
        `answered ${response.status}`,
      );
    await pipeline(response.body, createWriteStream(path), { signal });
    return true;
  }

  async #rest<Schema extends z.ZodType>(
    what: string,
    path: string,
    schema: Schema,
    signal: AbortSignal | undefined,
  ): Promise<z.infer<Schema>> {
    const response = await send(
      what,
      path,
      { headers: this.#headers() },
      signal,
    );
    return parsed(what, schema, await json(what, response));
  }

  async #graphql<Schema extends z.ZodType>(
    query: PersistedQuery,
    variables: Readonly<Record<string, unknown>>,
    schema: Schema,
    signal: AbortSignal | undefined,
  ): Promise<z.infer<Schema>> {
    const response = await send(
      query.name,
      '/graphql/query',
      {
        method: 'POST',
        headers: {
          ...this.#headers(),
          'content-type': 'application/x-www-form-urlencoded',
          'x-fb-lsd': this.#lsd,
          'x-fb-friendly-name': query.name,
        },
        body: new URLSearchParams({
          doc_id: query.docId,
          variables: JSON.stringify(variablesOf(query, variables)),
          lsd: this.#lsd,
          fb_dtsg: this.#dtsg,
          fb_api_req_friendly_name: query.name,
          server_timestamps: 'true',
        }),
      },
      signal,
    );
    return parsed(query.name, schema, await json(query.name, response));
  }

  #headers(): Record<string, string> {
    return {
      cookie: this.#cookie,
      'user-agent': userAgent,
      accept: '*/*',
      referer: `${origin}/`,
      'x-ig-app-id': webAppId,
      'x-csrftoken': this.#csrf,
      'x-requested-with': 'XMLHttpRequest',
      // Instagram refuses some calls without the fetch metadata a browser
      // sends ("SecFetch Policy violation").
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
    };
  }
}

function nextOf(page: { end_cursor: string | null; has_next_page: boolean }) {
  return page.has_next_page ? page.end_cursor : null;
}

// One request, redirects not followed: Instagram redirects a session it does
// not accept to its login or challenge page.
async function send(
  what: string,
  path: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const response = await fetch(`${origin}${path}`, {
    ...init,
    redirect: 'manual',
    signal,
  });
  if (response.status === 429) throw new InstagramRateLimitError(what);
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location') ?? '';
    if (/\/accounts\/login|\/challenge/.test(location))
      throw new InstagramLoginError(what);
    throw new InstagramQueryError(what, `redirected to ${location}`);
  }
  return response;
}

// The JSON of an API answer: GraphQL answers a signed-in session as
// text/javascript, and REST as application/json. Instagram answers a session
// it does not accept with a web page, and a query it refuses with a list of
// errors and no data. Errors beside data are field errors, which the schema
// refuses only when the SDK reads the null field.
async function json(what: string, response: Response): Promise<unknown> {
  const type = response.headers.get('content-type') ?? '';
  if (type.startsWith('text/html')) throw new InstagramLoginError(what);
  if (
    !type.startsWith('application/json') &&
    !type.startsWith('text/javascript')
  )
    throw new InstagramQueryError(what, `answered ${response.status} ${type}`);
  const body: unknown = JSON.parse(
    (await response.text()).replace(/^for \(;;\);/, ''),
  );
  if (typeof body === 'object' && body !== null) {
    // Instagram also marks a throttled answer require_login; its message
    // tells the two apart.
    if (
      'message' in body &&
      typeof body.message === 'string' &&
      /wait a few minutes/i.test(body.message)
    )
      throw new InstagramRateLimitError(what);
    if ('require_login' in body && body.require_login === true)
      throw new InstagramLoginError(what);
    const hasData = 'data' in body && body.data !== null;
    if (
      'errors' in body &&
      Array.isArray(body.errors) &&
      body.errors.length > 0 &&
      !hasData
    )
      throw new InstagramQueryError(what, describe(body.errors[0]));
  }
  if (!response.ok)
    throw new InstagramQueryError(what, `answered ${response.status}`);
  return body;
}

function describe(error: unknown): string {
  if (typeof error !== 'object' || error === null) return String(error);
  const parts = ['summary', 'message', 'description']
    .map((field) => (field in error ? Reflect.get(error, field) : undefined))
    .filter((part) => typeof part === 'string');
  return parts.join(': ');
}

function parsed<Schema extends z.ZodType>(
  what: string,
  schema: Schema,
  body: unknown,
): z.infer<Schema> {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  const [issue] = result.error.issues;
  throw new InstagramQueryError(
    what,
    issue === undefined
      ? result.error.message
      : `${issue.path.join('.')}: ${issue.message}`,
    { cause: result.error },
  );
}
