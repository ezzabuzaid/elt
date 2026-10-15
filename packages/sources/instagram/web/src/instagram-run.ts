import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BrowserSession } from '@workspace/sdk-chromium-cookies';
import {
  type Highlight,
  InstagramWeb,
  type ListMedia,
  type Page,
  type Profile,
  type ReelMedia,
  type TimelineMedia,
} from '@workspace/sdk-instagram-web';

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
// list: a page two streams ask for is fetched once.
export class LaneReader<Item> {
  readonly lane: Lane<Item>;
  readonly #web: InstagramWeb;
  readonly #pages = new Map<string, Promise<Page<Item>>>();
  readonly #fetched = new Map<string, number>();

  constructor(lane: Lane<Item>, web: InstagramWeb) {
    this.lane = lane;
    this.#web = web;
  }

  // null once the run fetched pagesPerRun pages of this list of the profile.
  page(
    profile: Profile,
    cursor: string | null,
    signal: AbortSignal | undefined,
  ): Promise<Page<Item>> | null {
    const key = `${profile.pk}:${cursor ?? ''}`;
    const read = this.#pages.get(key);
    if (read !== undefined) return read;
    const fetched = this.#fetched.get(profile.pk) ?? 0;
    if (fetched >= pagesPerRun) return null;
    this.#fetched.set(profile.pk, fetched + 1);
    const page = this.lane.fetch(this.#web, profile, cursor, signal);
    this.#pages.set(key, page);
    return page;
  }
}

// One run against Instagram: the browser's session, the page's tokens, the
// pages and profiles the run read, and the files it staged.
export class InstagramRun implements AsyncDisposable {
  readonly web: InstagramWeb;
  readonly posts: LaneReader<TimelineMedia>;
  readonly reels: LaneReader<ReelMedia>;
  readonly reposts: LaneReader<ListMedia>;
  readonly tagged: LaneReader<ListMedia>;
  readonly #staging: string;
  readonly #profiles = new Map<string, Promise<Profile>>();
  readonly #highlights = new Map<string, Promise<Highlight[]>>();
  #downloads = 0;

  private constructor(web: InstagramWeb, staging: string) {
    this.web = web;
    this.#staging = staging;
    this.posts = new LaneReader(new PostsLane(), web);
    this.reels = new LaneReader(new ReelsLane(), web);
    this.reposts = new LaneReader(new RepostsLane(), web);
    this.tagged = new LaneReader(new TaggedLane(), web);
  }

  // Signs in with the session of the browser profile that signed in to
  // Instagram last.
  static async open(signal?: AbortSignal): Promise<InstagramRun> {
    const session = await BrowserSession.newest(
      'https://www.instagram.com/',
      'sessionid',
    );
    const web = await InstagramWeb.open(session, signal);
    const staging = await mkdtemp(
      join(tmpdir(), 'context-compiler-instagram-'),
    );
    return new InstagramRun(web, staging);
  }

  profile(id: string, signal: AbortSignal | undefined): Promise<Profile> {
    const read = this.#profiles.get(id);
    if (read !== undefined) return read;
    const profile = this.web.profile(id, signal);
    this.#profiles.set(id, profile);
    return profile;
  }

  highlights(
    profileId: string,
    signal: AbortSignal | undefined,
  ): Promise<Highlight[]> {
    const read = this.#highlights.get(profileId);
    if (read !== undefined) return read;
    const tray = this.web.highlights(profileId, signal);
    this.#highlights.set(profileId, tray);
    return tray;
  }

  // Saves an image under the run's staging folder; the caller removes it
  // once the record that carries it is loaded.
  async download(
    url: string,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const path = join(this.#staging, `${++this.#downloads}${extension(url)}`);
    await this.web.download(url, path, signal);
    return path;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await rm(this.#staging, { recursive: true, force: true });
  }
}

function extension(url: string): string {
  const match = /\.(jpe?g|png|webp|heic|mp4)$/i.exec(new URL(url).pathname);
  return match === null ? '' : `.${match[1]?.toLowerCase()}`;
}
