import { fields } from '../fields.ts';
import type { ReadContext } from '../instagram-stream.ts';
import { type Snapshot, SnapshotStream } from '../snapshot-stream.ts';

const { profileId, id, text } = fields;

const properties = {
  profileId,
  id: {
    ...id,
    description:
      'Instagram’s id of the highlight. The highlight_items stream’s highlightId.',
  },
  title: { ...text, description: 'The highlight’s title under its circle.' },
} as const;

// The highlights a profile keeps on its page: stories it saved past their day.
export class HighlightsStream extends SnapshotStream<typeof properties> {
  readonly name = 'highlights';
  readonly primaryKey = ['profileId', 'id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per highlight on the page of an Instagram profile the import reads. Primary key profileId, id. A highlight the profile removes is deleted.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected async scan({
    run,
    profileId: owner,
    signal,
  }: ReadContext): Promise<Snapshot<typeof properties>> {
    if (owner === null)
      throw new TypeError('Instagram highlights are read by profile');
    return {
      records: (await run.highlights(owner, signal)).map((highlight) => ({
        profileId: owner,
        id: highlightId(highlight.id),
        title: highlight.title,
      })),
    };
  }
}

// The tray names a highlight highlight:<id>; the id is the number.
export function highlightId(trayId: string): string {
  return trayId.replace(/^highlight:/, '');
}
