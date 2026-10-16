import type { SQLiteView } from '@workspace/elt-sqlite';

// Availability in the selected local copy, not a cloud inbox watermark.
export const mailContentStatus: SQLiteView = {
  name: 'mail_content_status',
  description:
    'One row describing content in this imported Mail selection. latest_received_at is an observed message date, not proof of cloud freshness. Counts reflect the currently imported streams; consult stream_status when a pass is partial. A missing text body can also be a message with no readable text, such as encrypted content.',
  columns: {
    message_count: 'Number of message index rows in this import.',
    latest_received_at:
      'Latest messages.dateReceived in this import, as a UTC timestamp; NULL for an empty import or messages without a received date. This does not establish when Mail last checked its server.',
    missing_message_files:
      'Messages with no imported message_files row whose availableLocally is true. Their full message file was unavailable on this Mac at extraction.',
    missing_text_bodies:
      'Messages without a nonempty, nonattachment text/plain or text/html part in message_parts. Includes messages not downloaded and messages with no readable text part.',
    attachment_count:
      'Number of attachments belonging to messages in this imported selection.',
    unavailable_attachments:
      'Attachments whose availableLocally is not true: their bytes were unavailable on this Mac. This is independent of whether attachment copying is enabled.',
  },
  query: `WITH message_totals AS (
    SELECT count(*) AS message_count, max(m.dateReceived) AS latest_received_at,
      count(*) FILTER (WHERE m.id NOT IN (
        SELECT messageId FROM message_files WHERE availableLocally = 1
      )) AS missing_message_files,
      count(*) FILTER (WHERE m.id NOT IN (
        SELECT messageId FROM message_parts
        WHERE contentType IN ('text/plain', 'text/html')
          AND NOT coalesce(isAttachment, 0) AND octet_length(text) > 0
      )) AS missing_text_bodies
    FROM messages m
  ), attachment_totals AS (
    SELECT count(*) AS attachment_count,
      count(*) FILTER (WHERE NOT coalesce(a.availableLocally, 0)) AS unavailable_attachments
    FROM attachments a JOIN messages m ON m.id = a.messageId
  )
  SELECT * FROM message_totals CROSS JOIN attachment_totals`,
};
