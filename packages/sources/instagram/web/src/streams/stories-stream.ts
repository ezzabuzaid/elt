import { type DeletionPolicy, Retention } from '@zukhruf/snapshot-differential';

import { fields, instant, kindOf, largest } from '../fields.ts';
import { type ReadContext, within } from '../instagram-stream.ts';
import { type Snapshot, SnapshotStream } from '../snapshot-stream.ts';

const { profileId, id, text, nullableText, instant: at } = fields;

const properties = {
  profileId,
  id: { ...id, description: 'Instagram’s id of the story.' },
  postedAt: { ...at, description: 'When the story was posted.' },
  expiresAt: {
    ...at,
    description:
      'When Instagram stops showing the story, a day after it was posted.',
  },
  kind: {
    type: 'string',
    enum: ['photo', 'video'],
    description: 'photo, or video, whose file is its cover frame.',
  },
  productType: {
    ...text,
    description: 'Instagram’s product type of the story, such as story.',
  },
  description: {
    ...nullableText,
    description:
      'The description Instagram wrote of the image, when it wrote one.',
  },
} as const;

// The stories a profile shows now. Instagram stops showing a story a day
// after it was posted without deleting it: its row stays. A story the
// profile deleted before then is deleted.
export class StoriesStream extends SnapshotStream<typeof properties> {
  readonly name = 'stories';
  readonly primaryKey = ['profileId', 'id'];
  override readonly supportsFileTransfer = true;
  override readonly expiresBy = 'expiresAt';
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per story an Instagram profile the import reads posted, with its image, whose text, such as a changed class time, is in attachment_text. Primary key profileId, id. A story stays after Instagram stops showing it; one the profile deleted earlier is deleted.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected override policy(): DeletionPolicy {
    return new Retention(new Date().toISOString());
  }

  protected async scan({
    run,
    profileId: owner,
    range,
    signal,
  }: ReadContext): Promise<Snapshot<typeof properties>> {
    if (owner === null)
      throw new TypeError('Instagram stories are read by profile');
    const images = new Map<string, string>();
    const records = (await run.web.stories(owner, signal))
      .filter((item) => within(range, instant(item.taken_at)))
      .map((item) => {
        const record = {
          profileId: owner,
          id: item.pk,
          postedAt: instant(item.taken_at),
          expiresAt: instant(item.expiring_at),
          kind: kindOf(item.media_type),
          productType: item.product_type,
          description: item.accessibility_caption,
        };
        images.set(
          this.keyOf(record),
          largest(item.image_versions2.candidates).url,
        );
        return record;
      });
    return { records, images };
  }
}
