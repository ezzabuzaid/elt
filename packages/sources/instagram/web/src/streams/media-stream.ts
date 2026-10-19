import { ClosedWorld } from '@zukhruf/snapshot-differential';

import {
  type RecordDraft,
  type SourceMessage,
  diffSnapshot,
} from '@workspace/elt';
import type {
  Image,
  ListMedia,
  Profile,
  ReelMedia,
  TimelineMedia,
} from '@workspace/sdk-instagram-web';

import { fields, instant, kindOf, largest } from '../fields.ts';
import type { LaneReader } from '../instagram-run.ts';
import {
  InstagramStream,
  type ReadContext,
  within,
} from '../instagram-stream.ts';
import type { LaneName } from '../lane.ts';
import { type LaneState, walk } from '../list-walk.ts';
import { readLane, readScan } from '../state.ts';

const { profileId, id, count, nullableText } = fields;

const properties = {
  profileId,
  list: {
    type: 'string',
    enum: ['posts', 'reels', 'reposts', 'tagged'],
    description:
      'The list the post is on: posts (the grid), reels (the reels tab), reposts or tagged. Join postId to the id of posts, reels, reposts or tagged_posts.',
  },
  postId: {
    ...id,
    description: 'Instagram’s id of the post the image or video belongs to.',
  },
  position: { ...count, description: 'The slide’s place in the post, from 0.' },
  id: { ...id, description: 'Instagram’s id of the image or video.' },
  kind: {
    type: ['string', 'null'],
    enum: ['photo', 'video'],
    description:
      'photo, or video, whose file is its cover frame; NULL for a slide of a reposted carousel, which the reposts tab does not say.',
  },
  width: { ...count, description: 'The width in pixels of the stored file.' },
  height: { ...count, description: 'The height in pixels of the stored file.' },
  description: {
    ...nullableText,
    description:
      'The description Instagram wrote of the image, when it wrote one.',
  },
} as const;

type Slide = {
  readonly id: string;
  readonly kind: string | null;
  readonly image: Image;
  readonly description: string | null;
};

// The images and videos of every post on a profile's four lists, each with
// its file: a photo as its largest rendition, a video as its cover frame.
// The text in the files is read into attachment_text. One scan walks all
// four lists, a part per page, and ends once every list has ended.
export class MediaStream extends InstagramStream<typeof properties> {
  readonly name = 'media';
  readonly primaryKey = ['profileId', 'list', 'postId', 'id'];
  override readonly supportsFileTransfer = true;
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per image or video of a post on the grid, the reels tab, the reposts tab or the tagged tab of an Instagram profile the import reads, a carousel’s slides one each; a reel is its cover frame. Primary key profileId, list, postId, id. The file is stored, and its text, such as a timetable posted as an image, is in attachment_text. A video’s own file is not stored.',
    properties,
    required: Object.keys(properties),
  } as const;

  async *read(context: ReadContext): AsyncGenerator<SourceMessage> {
    const { run, state, profileId: owner, range, signal } = context;
    if (owner === null)
      throw new TypeError('Instagram media are read by profile');
    const saved = readScan(this.name, state);
    const scan: MediaScan = {
      owner,
      profile: await run.profile(owner, signal),
      lanes: {
        posts: readLane(this.name, saved.lanes.posts),
        reels: readLane(this.name, saved.lanes.reels),
        reposts: readLane(this.name, saved.lanes.reposts),
        tagged: readLane(this.name, saved.lanes.tagged),
      },
      diff: saved.diff,
    };
    const { startAt } = range;
    yield* this.#lane(scan, run.posts, gridSlides, context, {
      olderThan:
        startAt === undefined
          ? undefined
          : (item) => instant(item.taken_at) < startAt,
      inRange: (item) => within(range, instant(item.taken_at)),
    });
    yield* this.#lane(scan, run.reels, reelSlides, context);
    yield* this.#lane(scan, run.reposts, listSlides, context);
    yield* this.#lane(scan, run.tagged, listSlides, context);
  }

  // One list's parts of the scan; the scan ends with the part that ends the
  // last list still going.
  async *#lane<Item>(
    scan: MediaScan,
    reader: LaneReader<Item>,
    slides: (item: Item) => readonly Slide[],
    context: ReadContext,
    {
      olderThan,
      inRange = () => true,
    }: {
      olderThan?: ((item: Item) => boolean) | undefined;
      inRange?: (item: Item) => boolean;
    } = {},
  ): AsyncGenerator<SourceMessage> {
    const name = reader.lane.name;
    for await (const part of walk(
      reader,
      scan.profile,
      scan.lanes[name],
      context.signal,
      olderThan,
    )) {
      scan.lanes = { ...scan.lanes, [name]: part.lane };
      const ends = Object.values(scan.lanes).every(({ ended }) => ended);
      if (ends)
        scan.lanes = {
          posts: { ...scan.lanes.posts, ended: false },
          reels: { ...scan.lanes.reels, ended: false },
          reposts: { ...scan.lanes.reposts, ended: false },
          tagged: { ...scan.lanes.tagged, ended: false },
        };
      const images = new Map<string, string>();
      const drafts = new Map<string, RecordDraft<typeof properties>>();
      for (const item of part.items.filter(inRange))
        slides(item).forEach((slide, position) => {
          const draft = {
            profileId: scan.owner,
            list: name,
            postId: reader.lane.id(item),
            position,
            id: slide.id,
            kind: slide.kind,
            width: slide.image.width,
            height: slide.image.height,
            description: slide.description,
          };
          const key = this.keyOf(draft);
          drafts.set(key, draft);
          images.set(key, slide.image.url);
        });
      yield* this.withImages(
        this.#part(scan, [...drafts.values()], ends),
        images,
        context,
      );
    }
  }

  async *#part(
    scan: MediaScan,
    drafts: readonly RecordDraft<typeof properties>[],
    ends: boolean,
  ): AsyncGenerator<SourceMessage> {
    for await (const message of diffSnapshot(
      this.describe(),
      this.validated(drafts),
      scan.diff,
      { policy: new ClosedWorld(), continues: !ends },
    ))
      if ('type' in message && message.type === 'STATE') {
        scan.diff = message.state;
        yield { ...message, state: { lanes: scan.lanes, diff: scan.diff } };
      } else yield message;
  }
}

// Where one profile's media scan stands while a run reads it.
type MediaScan = {
  readonly owner: string;
  readonly profile: Profile;
  lanes: Record<LaneName, LaneState>;
  diff: unknown;
};

function gridSlides(item: TimelineMedia): Slide[] {
  return (item.carousel_media ?? [item]).map((slide) => ({
    id: slide.pk,
    kind: kindOf(slide.media_type),
    image: largest(slide.image_versions2.candidates),
    description: slide.accessibility_caption,
  }));
}

function reelSlides(item: ReelMedia): Slide[] {
  return [
    {
      id: item.pk,
      kind: kindOf(item.media_type),
      image: largest(item.image_versions2.candidates),
      description: null,
    },
  ];
}

function listSlides(item: ListMedia): Slide[] {
  return (item.carousel_media ?? [item]).map((slide) => ({
    id: slide.pk,
    kind: slide.media_type === null ? null : kindOf(slide.media_type),
    image: largest(slide.image_versions2.candidates),
    description: null,
  }));
}
