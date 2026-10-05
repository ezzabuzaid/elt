-- message_subscription_evidence: One row per Messages message with English or Arabic billing, subscription or lifecycle terms in its subject, text or attachment metadata. Candidates include card alerts, offers, one-off purchases and cancellations, not proof of an active subscription. Reads main's views; when main is another connector, replace main. with the attached Messages alias before loading. Does not filter direction or dates, or parse attachment bytes.
-- source: The connector name, messages.
-- record_id: messages.guid; joins message_attachments.messageGuid within Messages.
-- occurred_at: messages.date, whose precise meaning Apple does not document; not a payment, expiry or renewal date extracted from the text.
-- date_kind: message; describes occurred_at.
-- correspondent: messages.handle, whose participant role Apple does not document; NULL when absent. handle_service in context disambiguates it.
-- title: Stored message subject; NULL when absent, as for most SMS messages.
-- text: messages.text, including the imported attributed-body fallback; NULL when unavailable. Does not include attachment bytes.
-- attachments: JSON array of guid, filename (the display transfer name), content_type and available_locally. Read copied bytes from attachments.attachmentRef by guid when the import copies attachments; never open the original native filename.
-- matched_terms: JSON array of literal terms found case-insensitively for ASCII in the subject, text or attachment metadata. This explains retrieval, not status or confidence.
-- context: JSON object with handle_service, is_from_me and service, retaining direction and participant clues without inferring ownership.
CREATE TEMP VIEW message_subscription_evidence AS
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
  records AS (
    SELECT
      m.*,
      (
        SELECT json_group_array(
          json_object(
            'guid', a.guid,
            'filename', a.transferName,
            'content_type', a.mimeType,
            'available_locally', json(iif(a.availableLocally, 'true', 'false'))
          )
          ORDER BY a.guid
        )
        FROM main.message_attachments j
        JOIN main.attachments a ON a.guid = j.attachmentGuid
        WHERE j.messageGuid = m.guid
      ) AS evidence_attachments
    FROM main.messages m
  ),
  candidates AS (
    SELECT
      m.*,
      (
        WITH document(content) AS MATERIALIZED (
          SELECT lower(coalesce(m.subject, '') || char(10) || coalesce(m.text, '') || char(10) || m.evidence_attachments)
        )
        SELECT json_group_array(term)
        FROM document CROSS JOIN terms
        WHERE instr(document.content, term) > 0
      ) AS matched_terms
    FROM records m
  )
SELECT
  'messages' AS source,
  guid AS record_id,
  date AS occurred_at,
  'message' AS date_kind,
  handle AS correspondent,
  subject AS title,
  text,
  evidence_attachments AS attachments,
  matched_terms,
  json_object(
    'handle_service', handleService,
    'is_from_me', isFromMe,
    'service', service
  ) AS context
FROM candidates
WHERE json_array_length(matched_terms) > 0;
