-- mail_subscription_evidence: One row per Mail message with English or Arabic billing, subscription or lifecycle terms in its subject, body or attachment metadata. These are candidates, including offers, one-off purchases and cancellations, not proof of an active subscription. Load mail_messages.sql first. Missing bodies and unparsed attachment bytes limit recall; no date, sender or deleted filter is imposed.
-- source: The connector name, mail.
-- record_id: Mail's local message identifier; joins messages.id and attachments.messageId.
-- occurred_at: Mail's received_at, not a payment, expiry or renewal date.
-- date_kind: received; describes occurred_at.
-- correspondent: Sender email address; NULL when absent.
-- title: Message subject, including its reply or forward prefix; NULL when absent.
-- text: mail_messages.body, preferring plain text and otherwise retaining raw HTML; NULL when unavailable. Does not include attachment bytes.
-- attachments: JSON attachment metadata from mail_messages, including part_id and available_locally. For copied bytes, read attachments.attachmentRef by messageId and partId; imports without copies do not have that column.
-- matched_terms: JSON array of literal terms found case-insensitively for ASCII in the subject, text or attachment metadata. This explains retrieval, not status or confidence.
-- context: JSON object with mailbox_url, conversation_id, Message-ID, recipients and the stored deleted marker. Retains account, duplicate and direction clues without inferring ownership.
CREATE TEMP VIEW mail_subscription_evidence AS
WITH
  terms(term) AS (
    VALUES
      ('subscription'), ('subscribed'), ('renew'), ('recurring'),
      ('billing'), ('invoice'), ('receipt'), ('membership'),
      ('monthly'), ('annual'), ('charged'), ('payment'),
      ('trial'), ('premium'), ('cancel'), ('expir'), ('upgrade'), ('downgrade'),
      ('اشتراك'), ('إشتراك'), ('تجديد'), ('فاتور'), ('إيصال'),
      ('شهري'), ('سنوي'), ('عضوي'), ('خصم'), ('دفع'), ('شراء'),
      ('مدفوع'), ('تجريبي'), ('إلغاء'), ('الغاء'), ('انتهاء')
  ),
  candidates AS (
    SELECT
      m.*,
      (
        WITH document(content) AS MATERIALIZED (
          SELECT lower(coalesce(m.subject, '') || char(10) || coalesce(m.body, '') || char(10) || m.attachments)
        )
        SELECT json_group_array(term)
        FROM document CROSS JOIN terms
        WHERE instr(document.content, term) > 0
      ) AS matched_terms
    FROM temp.mail_messages m
  )
SELECT
  'mail' AS source,
  id AS record_id,
  received_at AS occurred_at,
  'received' AS date_kind,
  sender AS correspondent,
  subject AS title,
  body AS text,
  attachments,
  matched_terms,
  json_object(
    'mailbox_url', mailbox_url,
    'conversation_id', conversation_id,
    'message_id_header', message_id_header,
    'recipients', json(recipients),
    'deleted', deleted
  ) AS context
FROM candidates
WHERE json_array_length(matched_terms) > 0;
