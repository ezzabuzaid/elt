import { setInterval } from 'node:timers/promises';

import {
  Catalog,
  type CopyConfiguration,
  type ExtractionCoverage,
  type JsonValue,
  type Partition,
  Source,
  type SourceMessage,
  type SourceWatchOptions,
  type Stream,
  isTimestamp,
} from '@workspace/elt';
import {
  BrowserSessionNotFoundError,
  SafeStorageUnavailableError,
} from '@workspace/sdk-chromium-cookies';
import { InstagramLoginError } from '@workspace/sdk-instagram-web';

import { InstagramRun } from './instagram-run.ts';
import type { DateRange, ReadContext } from './instagram-stream.ts';
import { CommentsStream } from './streams/comments-stream.ts';
import { FollowingStream } from './streams/following-stream.ts';
import { HighlightItemsStream } from './streams/highlight-items-stream.ts';
import { HighlightsStream } from './streams/highlights-stream.ts';
import { MediaStream } from './streams/media-stream.ts';
import { PostsStream } from './streams/posts-stream.ts';
import { ProfilesStream } from './streams/profiles-stream.ts';
import { ReelsStream } from './streams/reels-stream.ts';
import { RepostsStream } from './streams/reposts-stream.ts';
import { StoriesStream } from './streams/stories-stream.ts';
import { TaggedPostsStream } from './streams/tagged-posts-stream.ts';

type InstagramReader = {
  readonly name: string;
  describe(): Stream;
  read(context: ReadContext): AsyncGenerator<SourceMessage>;
};

// In the order a run reads them: the streams of one list after the one
// that reads its pages first, so they read the pages the run already has.
const readers = {
  following: new FollowingStream(),
  profiles: new ProfilesStream(),
  posts: new PostsStream(),
  media: new MediaStream(),
  comments: new CommentsStream(),
  reels: new ReelsStream(),
  reposts: new RepostsStream(),
  taggedPosts: new TaggedPostsStream(),
  stories: new StoriesStream(),
  highlights: new HighlightsStream(),
  highlightItems: new HighlightItemsStream(),
} satisfies Record<string, InstagramReader>;
const catalog = new Catalog(
  Object.values(readers).map((reader) => reader.describe()),
);
const readersByName = new Map<string, InstagramReader>(
  Object.values(readers).map((reader) => [reader.name, reader]),
);
// Instagram tells no client that a profile posted, so a watch reads again
// every hour.
const pollIntervalMs = 60 * 60 * 1000;

export type InstagramWebOptions = DateRange & {
  // The Instagram user ids of the profiles to read; none reads every account
  // the browser's Instagram account follows.
  readonly profileIds?: readonly string[];
};

// Reads Instagram profiles through instagram.com's own web API, signed in
// with the session of the browser that signed in to Instagram last: their
// posts, reels, reposts and tagged posts with every image, comments,
// stories and highlights, and the accounts the signed-in account follows.
export class InstagramWebSource extends Source<InstagramRun> {
  readonly identity = 'instagram-web';
  protected readonly catalog = catalog;
  readonly following = readers.following.describe();
  readonly profiles = readers.profiles.describe();
  readonly posts = readers.posts.describe();
  readonly media = readers.media.describe();
  readonly comments = readers.comments.describe();
  readonly reels = readers.reels.describe();
  readonly reposts = readers.reposts.describe();
  readonly taggedPosts = readers.taggedPosts.describe();
  readonly stories = readers.stories.describe();
  readonly highlights = readers.highlights.describe();
  readonly highlightItems = readers.highlightItems.describe();

  readonly profileIds: readonly string[];
  readonly range: DateRange;

  // A source for the profiles the options name; with none, it reads only
  // the accounts the signed-in account follows, as setup lists them.
  constructor({ profileIds = [], startAt, endAt }: InstagramWebOptions = {}) {
    super();
    for (const instant of [startAt, endAt])
      if (instant !== undefined && !isTimestamp(instant))
        throw new TypeError(
          `Instagram date range ${instant} is not a timestamp`,
        );
    // Instagram's following pages can overlap; each profile is one partition.
    this.profileIds = Object.freeze([...new Set(profileIds)]);
    this.range = Object.freeze({
      ...(startAt === undefined ? {} : { startAt }),
      ...(endAt === undefined ? {} : { endAt }),
    });
    Object.freeze(this);
  }

  // A source for the profiles the options name, or, when they name none,
  // for every account the signed-in account follows now.
  static async connect(
    options: InstagramWebOptions = {},
    signal?: AbortSignal,
  ): Promise<InstagramWebSource> {
    if (options.profileIds !== undefined && options.profileIds.length > 0)
      return new InstagramWebSource(options);
    await using run = await InstagramRun.open(signal);
    const followed: string[] = [];
    let next: string | null = null;
    do {
      const page = await run.web.following(next, signal);
      followed.push(...page.items.map(({ pk }) => pk));
      next = page.next;
    } while (next !== null);
    return new InstagramWebSource({ ...options, profileIds: followed });
  }

  protected override open(): Promise<InstagramRun> {
    return InstagramRun.open();
  }

  protected override partitions(): readonly Partition[] {
    return this.profileIds.map((profileId) => ({ profileId }));
  }

  protected override readonly configErrors = [
    BrowserSessionNotFoundError,
    SafeStorageUnavailableError,
    InstagramLoginError,
  ];

  override coverage(_stream: Stream): ExtractionCoverage {
    const selection: Record<string, JsonValue> = {
      profileIds: [...this.profileIds],
    };
    if (this.range.startAt !== undefined)
      selection.startAt = this.range.startAt;
    if (this.range.endAt !== undefined) selection.endAt = this.range.endAt;
    return {
      description:
        'What instagram.com shows the account signed in to Instagram in the browser, for the selected profiles: each run reads their newest posts and the next pages of a scan of each list, so a long list is complete after several runs, and their stories, highlights and comments. Posts outside the date range, when one is set, are left out; reels, reposts and tagged posts name no date and are not narrowed by it.',
      selection,
    };
  }

  override async currentAsOf() {
    return null;
  }

  protected override async *observe({
    streams,
    signal,
  }: SourceWatchOptions): AsyncGenerator<readonly Stream[]> {
    if (signal.aborted) return;
    yield streams;
    try {
      for await (const _ of setInterval(pollIntervalMs, undefined, { signal }))
        yield streams;
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError')) throw error;
    }
  }

  protected override async *extract(
    configuration: CopyConfiguration,
    state: unknown,
    partition: Partition | null,
    run: InstagramRun,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<SourceMessage> {
    const reader = readersByName.get(configuration.stream.name);
    if (reader === undefined)
      throw new Error(`Instagram has no stream ${configuration.stream.name}`);
    yield* reader.read({
      run,
      state,
      profileId: partition === null ? null : String(partition.profileId),
      range: this.range,
      configuration,
      files: configuration.fileReads.length > 0,
      signal,
    });
  }
}
