import { ClosedWorld } from '@zukhruf/snapshot-differential';

import { type SourceMessage, diffSnapshot } from '@workspace/elt';
import type { HighlightItems, Page } from '@workspace/sdk-instagram-web';

import { fields, instant, kindOf, largest } from '../fields.ts';
import {
  type DateRange,
  InstagramStream,
  type ReadContext,
  within,
} from '../instagram-stream.ts';
import { highlightId } from './highlights-stream.ts';

const { profileId, id, nullableText, instant: at } = fields;

const properties = {
  profileId,
  highlightId: {
    ...id,
    description: 'The highlights stream’s id of the highlight the story is in.',
  },
  id: { ...id, description: 'Instagram’s id of the story.' },
  postedAt: { ...at, description: 'When the story was posted.' },
  kind: {
    type: 'string',
    enum: ['photo', 'video'],
    description: 'photo, or video, whose file is its cover frame.',
  },
  description: {
    ...nullableText,
    description:
      'The description Instagram wrote of the image, when it wrote one.',
  },
} as const;

// The stories in a profile's highlights, each with its image. Instagram keeps
// at most 100 stories in one highlight. Each page Instagram answers, the
// stories of a few highlights, is one part of the scan, committed with its
// images: a download that fails loses that page only, and the next run's
// diff skips the stories already loaded, so their images are not fetched
// again.
export class HighlightItemsStream extends InstagramStream<typeof properties> {
  readonly name = 'highlight_items';
  readonly primaryKey = ['profileId', 'highlightId', 'id'];
  override readonly supportsFileTransfer = true;
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per story in a highlight of an Instagram profile the import reads, with its image, whose text is in attachment_text. Primary key profileId, highlightId, id. A story the profile removes from its highlight is deleted.',
    properties,
    required: Object.keys(properties),
  } as const;

  async *read(context: ReadContext): AsyncGenerator<SourceMessage> {
    const { run, profileId: owner, range, signal } = context;
    if (owner === null)
      throw new TypeError('Instagram highlights are read by profile');
    const ids = (await run.highlights(owner, signal)).map(({ id }) => id);
    let state = context.state;
    let after: string | null = null;
    do {
      const page: Page<HighlightItems> =
        ids.length === 0
          ? { items: [], next: null }
          : await run.web.highlightItems(ids, after, signal);
      const { records, images } = this.#part(owner, page.items, range);
      for await (const message of this.withImages(
        diffSnapshot(context.configuration, this.validated(records), state, {
          policy: new ClosedWorld(),
          continues: page.next !== null,
        }),
        images,
        context,
      )) {
        if ('type' in message && message.type === 'STATE')
          state = message.state;
        yield message;
      }
      after = page.next;
    } while (after !== null);
  }

  #part(
    owner: string,
    highlights: readonly HighlightItems[],
    range: DateRange,
  ) {
    const images = new Map<string, string>();
    const records = [];
    for (const highlight of highlights)
      for (const item of highlight.items) {
        const postedAt = instant(item.taken_at);
        if (!within(range, postedAt)) continue;
        const record = {
          profileId: owner,
          highlightId: highlightId(highlight.id),
          id: item.pk,
          postedAt,
          kind: kindOf(item.media_type),
          description: item.accessibility_caption,
        };
        images.set(
          this.keyOf(record),
          largest(item.image_versions2.candidates).url,
        );
        records.push(record);
      }
    return { records, images };
  }
}
