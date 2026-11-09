import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pMemoize from 'p-memoize';

import { BrowserSession } from '@eltjs/sdk-chromium-cookies';
import {
  type Highlight,
  InstagramWeb,
  type ListMedia,
  type Page,
  type Profile,
  type ReelMedia,
  type TimelineMedia,
} from '@eltjs/sdk-instagram-web';

import type { Lane } from './lane.ts';
import { PostsLane } from './lanes/posts-lane.ts';
import { ReelsLane } from './lanes/reels-lane.ts';
import { RepostsLane } from './lanes/reposts-lane.ts';
import { TaggedLane } from './lanes/tagged-lane.ts';

// The most pages of one list of one profile a run asks Instagram for, so a
// run stays below what Instagram answers with "Please wait a few minutes".
// A list longer than that is read over several runs.
const pagesPerRun = 10;

// The pages of one list a run read, shared by every stream that reads the
// list: a page two streams ask for is fetched once. A page Instagram did not
// give is not kept: the next stream to ask for it asks Instagram again.
export class LaneReader<Item> {
  readonly lane: Lane<Item>;
  readonly #web: InstagramWeb;
  readonly #fetched = new Map<string, number>();

  constructor(lane: Lane<Item>, web: InstagramWeb) {
    this.lane = lane;
    this.#web = web;
  }

  // null once the run asked Instagram for pagesPerRun pages of this list of
  // the profile.
  readonly page = pMemoize(
    async (
      profile: Profile,
      cursor: string | null,
      signal: AbortSignal | undefined,
    ): Promise<Page<Item> | null> => {
      const fetched = this.#fetched.getOrInsert(profile.pk, 0);
      if (fetched >= pagesPerRun) return null;
      this.#fetched.set(profile.pk, fetched + 1);
      return this.lane.fetch(this.#web, profile, cursor, signal);
    },
    { cacheKey: ([profile, cursor]) => `${profile.pk}:${cursor ?? ''}` },
  );
}

// One run against Instagram: the browser's session, the page's tokens, the
// pages and profiles the run read, and the files it staged. A profile or a
// highlights tray Instagram did not give is not kept: the next stream to ask
// for it asks Instagram again.
export class InstagramRun implements AsyncDisposable {
  readonly web: InstagramWeb;
  readonly posts: LaneReader<TimelineMedia>;
  readonly reels: LaneReader<ReelMedia>;
  readonly reposts: LaneReader<ListMedia>;
  readonly tagged: LaneReader<ListMedia>;
  // When the run opened: the session's cookies are valid then, and a story
  // that expires after it is still shown.
  readonly openedAt: Date;
  readonly #staging: string;
  #downloads = 0;

  private constructor(web: InstagramWeb, openedAt: Date, staging: string) {
    this.web = web;
    this.openedAt = openedAt;
    this.#staging = staging;
    this.posts = new LaneReader(new PostsLane(), web);
    this.reels = new LaneReader(new ReelsLane(), web);
    this.reposts = new LaneReader(new RepostsLane(), web);
    this.tagged = new LaneReader(new TaggedLane(), web);
  }

  // Signs in at now with the session of the browser profile that signed in
  // to Instagram last, in the home folder home.
  static async open(
    home: string,
    now: Date,
    signal?: AbortSignal,
  ): Promise<InstagramRun> {
    const session = await BrowserSession.newest(
      'https://www.instagram.com/',
      'sessionid',
      { home, now },
    );
    const web = await InstagramWeb.open(session, signal);
    const staging = await mkdtemp(join(tmpdir(), 'elt-instagram-'));
    return new InstagramRun(web, now, staging);
  }

  readonly profile = pMemoize(
    (id: string, signal: AbortSignal | undefined): Promise<Profile> =>
      this.web.profile(id, signal),
  );

  readonly highlights = pMemoize(
    (
      profileId: string,
      signal: AbortSignal | undefined,
    ): Promise<Highlight[]> => this.web.highlights(profileId, signal),
  );

  // Saves an image under the run's staging folder; the caller removes it
  // once the record that carries it is loaded. Null when Instagram no longer
  // has the file: the record loads without it.
  async download(
    url: string,
    signal: AbortSignal | undefined,
  ): Promise<string | null> {
    const path = join(this.#staging, `${++this.#downloads}${extension(url)}`);
    return (await this.web.download(url, path, signal)) ? path : null;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await rm(this.#staging, { recursive: true, force: true });
  }
}

function extension(url: string): string {
  const match = /\.(jpe?g|png|webp|heic|mp4)$/i.exec(new URL(url).pathname);
  return match === null ? '' : `.${match[1]?.toLowerCase()}`;
}
