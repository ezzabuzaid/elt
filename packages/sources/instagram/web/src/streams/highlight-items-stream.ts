import { fields, instant, kindOf, largest } from '../fields.ts';
import { type ReadContext, within } from '../instagram-stream.ts';
import { type Snapshot, SnapshotStream } from '../snapshot-stream.ts';
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
// at most 100 stories in one highlight.
export class HighlightItemsStream extends SnapshotStream<typeof properties> {
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

  protected async scan({
    run,
    profileId: owner,
    range,
    signal,
  }: ReadContext): Promise<Snapshot<typeof properties>> {
    if (owner === null)
      throw new TypeError('Instagram highlights are read by profile');
    const ids = (await run.highlights(owner, signal)).map(({ id }) => id);
    const images = new Map<string, string>();
    const records = [];
    let after: string | null = null;
    while (ids.length > 0) {
      const page = await run.web.highlightItems(ids, after, signal);
      for (const highlight of page.items)
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
      if (page.next === null) break;
      after = page.next;
    }
    return { records, images };
  }
}
