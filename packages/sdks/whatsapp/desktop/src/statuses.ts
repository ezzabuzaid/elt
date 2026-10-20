import { Snapshot } from '@zukhruf/sqlite-snapshot';

import { messageMediaFile } from './chat-storage.ts';
import { WhatsAppSchemaError, WhatsAppUnavailableError } from './errors.ts';
import { flag, number, onDisk, requiredText, text } from './values.ts';

// A status a contact or the account posted, with its text styling or link
// preview and its photo or video, as WhatsApp keeps it until the status
// expires a day after it was posted (statusDB/Status.sqlite). The account's
// own statuses name their sender status_me.
export type Status = {
  readonly senderJid: string;
  readonly uuid: string;
  readonly type: number;
  readonly sortId: number | null;
  readonly timestamp: string | null;
  readonly serverReceiptTimestamp: string | null;
  readonly receivedTimestamp: string | null;
  readonly text: string | null;
  readonly state: number | null;
  readonly origin: number | null;
  readonly flags: number | null;
  readonly isArchived: boolean | null;
  readonly audienceType: number | null;
  readonly url: string | null;
  readonly pageTitle: string | null;
  readonly pageDescription: string | null;
  readonly fontStyle: number | null;
  readonly textColor: number | null;
  readonly backgroundColor: number | null;
  readonly previewType: number | null;
  readonly mimeType: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly fileSize: number | null;
  readonly mediaDuration: number | null;
  readonly accessibilityLabel: string | null;
  readonly fileHash: string | null;
  readonly filePath: string | null;
  // filePath on disk, when the file is there.
  readonly file: string | null;
};

// How long a status lasts after it is posted. WhatsApp removes an expired
// status some time after, without a deletion.
export const statusLifetimeMs = 24 * 3_600_000;

// Left out: each status's secret and media key, the hashes and server paths
// WhatsApp downloads media by, its reporting tokens and its per-sender
// counts.
const requiredColumns = {
  status: [
    'row_id',
    'sender_user_jid',
    'uuid',
    'type',
    'sort_id',
    'timestamp',
    'server_receipt_timestamp',
    'received_timestamp',
    'text_data',
    'state',
    'origin',
    'flags',
    'is_archived',
    'audience_type',
  ],
  status_text: [
    'status_row_id',
    'url',
    'page_title',
    'page_description',
    'font_style',
    'text_color',
    'background_color',
    'preview_type',
  ],
  status_media_link: ['status_row_id', 'media_content_row_id'],
  media_content: [
    'row_id',
    'mime_type',
    'width',
    'height',
    'file_size',
    'media_duration',
    'accessibility_label',
    'file_hash',
    'file_path',
  ],
};

// Status.sqlite keeps whole seconds since 2001-01-01 UTC, so an instant to
// the millisecond holds each exactly.
function instant(value: unknown): string | null {
  return value === null
    ? null
    : new Date((Number(value) + 978307200) * 1000).toISOString();
}

// statusDB/Status.sqlite as of one moment.
export class StatusesSnapshot implements Disposable {
  readonly #database: Snapshot;
  readonly #container: string;

  constructor(path: string, container: string) {
    this.#database = new Snapshot(path, WhatsAppUnavailableError);
    this.#database.requireColumns(requiredColumns, WhatsAppSchemaError);
    this.#container = container;
  }

  statuses(): Status[] {
    return this.#database
      .all(
        `SELECT status.sender_user_jid AS senderJid, status.uuid,
                status.type, status.sort_id AS sortId, status.timestamp,
                status.server_receipt_timestamp AS serverReceiptTimestamp,
                status.received_timestamp AS receivedTimestamp,
                status.text_data AS text, status.state, status.origin,
                status.flags, status.is_archived AS isArchived,
                status.audience_type AS audienceType, styled.url,
                styled.page_title AS pageTitle,
                styled.page_description AS pageDescription,
                styled.font_style AS fontStyle,
                styled.text_color AS textColor,
                styled.background_color AS backgroundColor,
                styled.preview_type AS previewType,
                media.mime_type AS mimeType, media.width, media.height,
                media.file_size AS fileSize,
                media.media_duration AS mediaDuration,
                media.accessibility_label AS accessibilityLabel,
                media.file_hash AS fileHash, media.file_path AS filePath
         FROM status
         LEFT JOIN status_text AS styled ON styled.status_row_id = status.row_id
         LEFT JOIN status_media_link AS link ON link.status_row_id = status.row_id
         LEFT JOIN media_content AS media ON media.row_id = link.media_content_row_id
         ORDER BY status.row_id`,
      )
      .map((row) => {
        const filePath = text(row.filePath);
        return {
          senderJid: requiredText(
            row.senderJid,
            'A WhatsApp status has no sender',
          ),
          uuid: requiredText(row.uuid, 'A WhatsApp status has no ID'),
          type: Number(row.type),
          sortId: number(row.sortId),
          timestamp: instant(row.timestamp),
          serverReceiptTimestamp: instant(row.serverReceiptTimestamp),
          receivedTimestamp: instant(row.receivedTimestamp),
          text: text(row.text),
          state: number(row.state),
          origin: number(row.origin),
          flags: number(row.flags),
          isArchived: flag(row.isArchived),
          audienceType: number(row.audienceType),
          url: text(row.url),
          pageTitle: text(row.pageTitle),
          pageDescription: text(row.pageDescription),
          fontStyle: number(row.fontStyle),
          textColor: number(row.textColor),
          backgroundColor: number(row.backgroundColor),
          previewType: number(row.previewType),
          mimeType: text(row.mimeType),
          width: number(row.width),
          height: number(row.height),
          fileSize: number(row.fileSize),
          mediaDuration: number(row.mediaDuration),
          accessibilityLabel: text(row.accessibilityLabel),
          fileHash: text(row.fileHash),
          filePath,
          file:
            filePath === null
              ? null
              : onDisk(messageMediaFile(this.#container, filePath)),
        };
      });
  }

  [Symbol.dispose](): void {
    this.#database[Symbol.dispose]();
  }
}
