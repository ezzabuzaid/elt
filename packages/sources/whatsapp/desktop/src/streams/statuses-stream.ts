import type { RecordDraft, SchemaRecord } from '@workspace/elt';
import {
  type Status,
  messageMediaFile,
  statusLifetimeMs,
} from '@workspace/sdk-whatsapp-desktop';

import type { WhatsAppScan } from '../whatsapp-scan.ts';
import { WhatsAppStream, whatsappFields } from '../whatsapp-stream.ts';

const {
  jid,
  text,
  integer,
  boolean,
  nullableInteger,
  nullableText,
  nullableBoolean,
} = whatsappFields;
// Whole seconds, held to the millisecond, as an expiring field must be.
const instant = { ...text, format: 'date-time' } as const;
const nullableInstant = { ...nullableText, format: 'date-time' } as const;
const column = (what: string, name: string) => `${what} (${name}).`;
// WhatsApp expires a status by its own clock; an hour inside the lifetime
// absorbs a clock that differs from this Mac's.
const marginMs = 3_600_000;

const properties = {
  senderJid: {
    ...jid,
    description: column(
      'Who posted the status; status_me for the account’s own',
      'status.sender_user_jid',
    ),
  },
  uuid: {
    ...text,
    minLength: 1,
    description: column(
      'The status’s ID; with senderJid, the primary key',
      'status.uuid',
    ),
  },
  type: {
    ...integer,
    description: column(
      'WhatsApp’s undocumented kind, seen as 3 text, 4 photo, 5 video, 10 a link, whose text is its URL',
      'status.type',
    ),
  },
  sortId: {
    ...nullableInteger,
    description: column(
      'Its place among the sender’s statuses',
      'status.sort_id',
    ),
  },
  timestamp: {
    ...instant,
    description: column('When it was posted, UTC', 'status.timestamp'),
  },
  serverReceiptTimestamp: {
    ...nullableInstant,
    description: column(
      'When WhatsApp’s server took it, UTC',
      'server_receipt_timestamp',
    ),
  },
  receivedTimestamp: {
    ...nullableInstant,
    description: column(
      'When this account received it, UTC',
      'received_timestamp',
    ),
  },
  text: {
    ...nullableText,
    description: column(
      'The text, a photo’s or video’s caption, or a link post’s URL',
      'status.text_data',
    ),
  },
  state: {
    ...nullableInteger,
    description: column(
      'WhatsApp’s undocumented state code; 5 and 6 once viewed',
      'status.state',
    ),
  },
  origin: {
    ...nullableInteger,
    description: column('WhatsApp’s undocumented origin code', 'status.origin'),
  },
  flags: {
    ...nullableInteger,
    description: column('WhatsApp’s undocumented bit flags', 'status.flags'),
  },
  isArchived: {
    ...nullableBoolean,
    description: column(
      'Whether the account’s own status is kept in its archive after it expired',
      'status.is_archived',
    ),
  },
  audienceType: {
    ...nullableInteger,
    description: column(
      'WhatsApp’s undocumented audience code',
      'status.audience_type',
    ),
  },
  url: {
    ...nullableText,
    description: column('A link post’s link', 'status_text.url'),
  },
  pageTitle: {
    ...nullableText,
    description: column('The linked page’s title', 'status_text.page_title'),
  },
  pageDescription: {
    ...nullableText,
    description: column(
      'The linked page’s description',
      'status_text.page_description',
    ),
  },
  fontStyle: {
    ...nullableInteger,
    description: column('A text status’s font', 'status_text.font_style'),
  },
  textColor: {
    ...nullableInteger,
    description: column(
      'A text status’s text color, ARGB',
      'status_text.text_color',
    ),
  },
  backgroundColor: {
    ...nullableInteger,
    description: column(
      'A text status’s background color, ARGB',
      'status_text.background_color',
    ),
  },
  previewType: {
    ...nullableInteger,
    description: column(
      'WhatsApp’s undocumented link preview kind',
      'status_text.preview_type',
    ),
  },
  mimeType: {
    ...nullableText,
    description: column(
      'The photo’s or video’s MIME type',
      'media_content.mime_type',
    ),
  },
  width: {
    ...nullableInteger,
    description: column('Width in pixels', 'media_content.width'),
  },
  height: {
    ...nullableInteger,
    description: column('Height in pixels', 'media_content.height'),
  },
  fileSize: {
    ...nullableInteger,
    description: column('The file’s size in bytes', 'media_content.file_size'),
  },
  mediaDuration: {
    ...nullableInteger,
    description: column(
      'A video’s length in seconds',
      'media_content.media_duration',
    ),
  },
  accessibilityLabel: {
    ...nullableText,
    description: column(
      'Its description for screen readers',
      'media_content.accessibility_label',
    ),
  },
  fileHash: {
    ...nullableText,
    description: column(
      'The SHA-256 of the photo or video, base64',
      'media_content.file_hash',
    ),
  },
  filePath: {
    ...nullableText,
    description: column(
      'Where WhatsApp keeps the file, relative to the Message folder of its container',
      'media_content.file_path',
    ),
  },
  mediaAvailableLocally: {
    ...boolean,
    description:
      'Whether the file at filePath was on this Mac when the record was read. File bytes are exported only when true.',
  },
} as const;

export class StatusesStream extends WhatsAppStream<typeof properties, Status> {
  readonly name = 'statuses';
  readonly store = 'statuses';
  readonly primaryKey = ['senderJid', 'uuid'];
  readonly supportsFileTransfer = true;
  readonly expiresBy = 'timestamp';
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per status a contact or the account posted that WhatsApp held when read, with its text styling or link preview and its photo or video (statusDB/Status.sqlite). WhatsApp removes a contact’s status a day after it is posted, without a deletion, so a status stays loaded after that; one that vanished within its day was withdrawn and is deleted. Primary key senderJid, uuid. Not narrowed by an import’s chats or dates.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: WhatsAppScan): readonly Status[] {
    return scan.statuses.statuses();
  }

  protected record({
    file,
    ...status
  }: Status): RecordDraft<typeof properties> {
    return { ...status, mediaAvailableLocally: file !== null };
  }

  override horizon(scan: WhatsAppScan): string {
    return new Date(
      scan.startedAt.getTime() - statusLifetimeMs + marginMs,
    ).toISOString();
  }

  override file(
    { filePath, mediaAvailableLocally }: SchemaRecord<typeof properties>,
    scan: WhatsAppScan,
  ): string | null {
    return mediaAvailableLocally && filePath !== null
      ? messageMediaFile(scan.container, filePath)
      : null;
  }
}
