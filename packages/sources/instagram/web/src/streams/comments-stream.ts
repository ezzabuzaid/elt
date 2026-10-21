import { ClosedWorld } from '@zukhruf/snapshot-differential';

import { type SourceMessage, diffGroupedSnapshot } from '@workspace/elt';
import type {
  Comment,
  InstagramWeb,
  TimelineMedia,
  TopComment,
} from '@workspace/sdk-instagram-web';

import { fields, instant } from '../fields.ts';
import {
  InstagramStream,
  type ReadContext,
  within,
} from '../instagram-stream.ts';
import { walk } from '../list-walk.ts';
import { foreign, readLane, readScan } from '../state.ts';

const { profileId, id, text, nullableText, count, instant: at } = fields;

const properties = {
  profileId,
  postId: {
    ...id,
    description: 'The posts stream’s id of the post the comment is on.',
  },
  id: { ...id, description: 'Instagram’s id of the comment.' },
  parentId: {
    ...nullableText,
    description:
      'The id of the comment this one replies to; NULL for a comment on the post itself.',
  },
  text: { ...text, description: 'The comment’s text.' },
  author: {
    ...text,
    description: 'The username of the account that wrote it.',
  },
  authorId: {
    ...id,
    description: 'The Instagram user id of the account that wrote it.',
  },
  createdAt: { ...at, description: 'When it was written.' },
  likes: {
    ...count,
    description:
      'How many accounts liked the comment, when the post’s comments were last read.',
  },
  replies: {
    type: ['integer', 'null'],
    minimum: 0,
    description: 'How many replies the comment has; NULL for a reply.',
  },
} as const;

// The comments on the posts of a profile's grid, with their replies. A
// post's comments are read again when its comment count changes, and once
// in every scan of the grid, so likes stay current.
export class CommentsStream extends InstagramStream<typeof properties> {
  readonly name = 'comments';
  readonly primaryKey = ['profileId', 'postId', 'id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per comment, or reply to a comment, on a post on the grid of an Instagram profile the import reads. Primary key profileId, postId, id. Read with the posts stream’s pages; a comment the post no longer shows is deleted when its post’s comments are read again.',
    properties,
    required: Object.keys(properties),
  } as const;

  async *read({
    run,
    state,
    configuration,
    profileId: owner,
    range,
    signal,
  }: ReadContext): AsyncGenerator<SourceMessage> {
    if (owner === null)
      throw new TypeError('Instagram comments are read by profile');
    const profile = await run.profile(owner, signal);
    const saved = readScan(this.name, state);
    const scanned = saved.extra.scan ?? 0;
    if (typeof scanned !== 'number') throw foreign(this.name);
    let scan = scanned;
    let diff = saved.diff;
    const inRange = (item: TimelineMedia) =>
      within(range, instant(item.taken_at));
    const { startAt } = range;
    for await (const part of walk(
      run.posts,
      profile,
      readLane(this.name, saved.lanes.posts),
      signal,
      startAt === undefined
        ? undefined
        : (item) => instant(item.taken_at) < startAt,
    )) {
      const posts = new Map(
        part.items.filter(inRange).map((post) => [post.pk, post]),
      );
      const groups = [...posts.values()].map((post) => ({
        key: post.pk,
        fingerprint: `${post.comment_count}@${scan}`,
        records: () => this.#comments(run.web, owner, post, signal),
      }));
      const lane = part.ends ? { ...part.lane, ended: false } : part.lane;
      for await (const message of diffGroupedSnapshot(
        configuration,
        groups,
        diff,
        {
          policy: new ClosedWorld(),
          continues: !part.ends,
          signal,
        },
      ))
        if ('type' in message && message.type === 'STATE') {
          diff = message.state;
          if (part.ends) scan += 1;
          yield {
            ...message,
            state: { lanes: { posts: lane }, diff, scan },
          };
        } else yield message;
    }
  }

  async *#comments(
    web: InstagramWeb,
    owner: string,
    post: TimelineMedia,
    signal: AbortSignal | undefined,
  ) {
    if (post.comment_count === 0) return;
    // Instagram can list one comment several times in one answer.
    const comments = new Map<string, TopComment>();
    let next: string | null = null;
    do {
      const page = await web.comments(post.pk, next, signal);
      for (const comment of page.items) comments.set(comment.pk, comment);
      next = page.next;
    } while (next !== null);
    for (const comment of comments.values()) {
      yield* this.validated([
        this.#record(owner, post, comment, null, comment.child_comment_count),
      ]);
      if (comment.child_comment_count === 0) continue;
      let cursor: string | null = null;
      do {
        const page = await web.replies(post.pk, comment.pk, cursor, signal);
        yield* this.validated(
          page.items.map((reply) =>
            this.#record(owner, post, reply, comment.pk, null),
          ),
        );
        cursor = page.next;
      } while (cursor !== null);
    }
  }

  #record(
    owner: string,
    post: TimelineMedia,
    comment: Comment,
    parentId: string | null,
    replies: number | null,
  ) {
    return {
      profileId: owner,
      postId: post.pk,
      id: comment.pk,
      parentId,
      text: comment.text,
      author: comment.user.username,
      authorId: comment.user.pk,
      createdAt: instant(comment.created_at),
      likes: comment.comment_like_count,
      replies,
    };
  }
}
