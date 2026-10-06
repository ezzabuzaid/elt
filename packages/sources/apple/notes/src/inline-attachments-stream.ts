import type { RecordDraft } from '@workspace/elt';
import type { InlineAttachment } from '@workspace/sdk-apple-notes';

import { AppleNotesStream, notesFields } from './apple-notes-stream.ts';
import { type NotesScan, string } from './notes-scan.ts';

const { id, text, nullableText, nullableTimestamp } = notesFields;

const properties = {
  id: { ...id, description: 'Notes identifier of this inline attachment.' },
  noteId: {
    ...id,
    description:
      'Containing note identifier; refers to notes.id within this source. One note can contain many inline attachments.',
  },
  type: {
    ...text,
    description:
      'Notes type identifier, such as com.apple.notes.inlinetextattachment.hashtag; distinguishes tags, mentions, note links and calculation results.',
  },
  text: {
    ...nullableText,
    description:
      'Text displayed inline, such as #travel; NULL when not recorded.',
  },
  target: {
    ...nullableText,
    description:
      'Stored target of the inline attachment: for example a normalized tag name such as TRAVEL, or an applenotes:note/<id> URL. Its meaning depends on type; NULL when not recorded.',
  },
  createdAt: {
    ...nullableTimestamp,
    description:
      'Creation time recorded by Notes, converted to a UTC instant; NULL when unavailable.',
  },
} as const;

export class InlineAttachmentsStream extends AppleNotesStream<
  typeof properties,
  InlineAttachment
> {
  readonly name = 'inlineAttachments';
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per inline tag, mention, note link or calculation attachment belonging to an exported note. These are structured references to content also rendered in the note body, not additional notes or file attachments.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: NotesScan): readonly InlineAttachment[] {
    return [...scan.inline.values()];
  }

  protected record(inline: InlineAttachment): RecordDraft<typeof properties> {
    return {
      id: inline.id,
      noteId: inline.noteId,
      type: inline.type,
      text: string(inline.altText),
      target: string(inline.target),
      createdAt: inline.createdAt?.toISOString() ?? null,
    };
  }
}
