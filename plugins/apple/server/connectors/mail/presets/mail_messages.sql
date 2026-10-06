-- mail_messages: One row per message in Mail's index, with what a reader of it sees: dates, mailbox, sender, recipients, subject, Message-ID, body and attachments. Built from the messages, addresses, subjects, mailboxes, recipients, message_global_data, message_parts and attachments views.
-- id: Mail's local message identifier (messages.id); message_parts.messageId and attachments.messageId refer to it.
-- received_at: When Mail received the message, as a UTC timestamp.
-- sent_at: When the message was sent, as a UTC timestamp; NULL when the index has no date.
-- mailbox: The mailbox holding the message (mailboxes.id).
-- mailbox_url: That mailbox's URL: its host is the account identifier, its path the mailbox path, percent-encoded.
-- conversation_id: Mail's conversation identifier; messages of one thread share it.
-- read: 1 when the message is marked read, 0 when unread.
-- flagged: 1 when the message is flagged, 0 otherwise.
-- deleted: Mail's deleted marker as stored; Apple does not document it, and it was 0 on every message of a live store on 2026-10-05.
-- sender: The sender's email address.
-- sender_name: The sender's display name; NULL when the message gives none.
-- recipients: JSON array of the To and Cc recipients in Mail's order: address, name (NULL when none is given), and kind 'to' or 'cc' (Mail's codes 0 and 1, matched against the To and Cc headers on 2026-10-05), or Mail's code as text for any other recipient.
-- subject: The subject as Mail shows it, with its reply or forward prefix such as 'Re: '; NULL when the message has none.
-- message_id_header: The Message-ID header, such as <id@example.com>; it identifies the message across mailboxes, accounts and other copies.
-- body: The text of the message: its text/plain parts joined in partId order, or, when it has none, its text/html parts as raw HTML; NULL when this Mac has no local copy of the message or it has no text part. A forwarded message stays one attachment, so its text is not in body.
-- attachments: JSON array of the message's attachments in partId order: part_id, filename, content_type, declared_bytes and available_locally (false when its file is missing on this Mac). For a copied file, join attachments on messageId and partId and read attachmentRef, which exists only when the import copies attachments.
CREATE TEMP VIEW mail_messages AS
-- body and attachments are read per message through the (messageId, partId)
-- key, so a query computes them only for the rows it keeps. Recipients have no
-- key on message, so they are grouped once.
WITH
  recipient_lists AS (
    SELECT
      r.message,
      json_group_array(
        json_object(
          'address', a.address,
          'name', nullif(a.comment, ''),
          'kind', CASE r.type WHEN 0 THEN 'to' WHEN 1 THEN 'cc' ELSE CAST(r.type AS TEXT) END
        )
        ORDER BY r.type, r.position
      ) AS recipients
    FROM recipients r
    LEFT JOIN addresses a ON a.id = r.address
    GROUP BY r.message
  )
SELECT
  m.id,
  m.dateReceived AS received_at,
  m.dateSent AS sent_at,
  m.mailbox,
  x.url AS mailbox_url,
  m.conversationId AS conversation_id,
  m.read,
  m.flagged,
  m.deleted,
  a.address AS sender,
  nullif(a.comment, '') AS sender_name,
  coalesce(r.recipients, json('[]')) AS recipients,
  nullif(coalesce(m.subjectPrefix, '') || coalesce(s.subject, ''), '') AS subject,
  g.messageIdHeader AS message_id_header,
  coalesce(
    (
      SELECT group_concat(p.text, char(10) ORDER BY p.partId)
      FROM message_parts p
      WHERE p.messageId = m.id AND p.contentType = 'text/plain' AND NOT coalesce(p.isAttachment, 0)
    ),
    (
      SELECT group_concat(p.text, char(10) ORDER BY p.partId)
      FROM message_parts p
      WHERE p.messageId = m.id AND p.contentType = 'text/html' AND NOT coalesce(p.isAttachment, 0)
    )
  ) AS body,
  (
    SELECT json_group_array(
      json_object(
        'part_id', f.partId,
        'filename', f.filename,
        'content_type', f.contentType,
        'declared_bytes', f.declaredBytes,
        'available_locally', json(iif(f.availableLocally, 'true', 'false'))
      )
      ORDER BY f.partId
    )
    FROM attachments f
    WHERE f.messageId = m.id
  ) AS attachments
FROM messages m
LEFT JOIN mailboxes x ON x.id = m.mailbox
LEFT JOIN addresses a ON a.id = m.sender
LEFT JOIN subjects s ON s.id = m.subject
LEFT JOIN message_global_data g ON g.id = m.globalMessageId
LEFT JOIN recipient_lists r ON r.message = m.id;
