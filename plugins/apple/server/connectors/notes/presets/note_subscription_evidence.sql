-- note_subscription_evidence: One row per Notes note with English or Arabic billing, subscription or lifecycle terms in its title, body or attachment metadata, including stored OCR and transcripts. Candidates may be plans, old trackers, offers or cancellations, not proof of an active subscription. Reads main's views; when main is another connector, replace main. with the attached Notes alias before loading. Locked titles and Recently Deleted notes remain candidates; unavailable text and unparsed file bytes limit recall.
-- source: The connector name, notes.
-- record_id: notes.id; joins attachments.noteId within Notes.
-- occurred_at: notes.modifiedAt; a note edit time, not a payment, expiry or renewal date.
-- date_kind: modified; describes occurred_at.
-- correspondent: NULL; Notes supplies no sender.
-- title: Note title, which can be readable even when its body is locked; NULL when absent.
-- text: Markdown body, falling back to plain text, followed by labeled attachment summaries, stored OCR, handwriting and transcripts. NULL when none is readable. Does not parse file bytes.
-- attachments: JSON array of id, filename, type and available_locally. Read copied bytes from attachments.attachmentRef by id when the import copies attachments; metadata does not prove bytes are available.
-- matched_terms: JSON array of literal terms found case-insensitively for ASCII in the title, text or attachment metadata. This explains retrieval, not status or confidence.
-- context: JSON object with account_id, folder_id and locked, retaining location and readability clues without inferring ownership.
CREATE TEMP VIEW note_subscription_evidence AS
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
      n.*,
      nullif(trim(
        coalesce(n.markdown, n.text, '') || coalesce((
          SELECT group_concat(
            char(10) || '[Attachment ' || a.id || ']' || char(10) ||
            trim(coalesce(a.summary, '') || char(10) || coalesce(a.ocrText, '') || char(10) || coalesce(a.handwritingText, '') || char(10) || coalesce(a.transcript, '')),
            char(10) ORDER BY a.id
          )
          FROM main.attachments a
          WHERE a.noteId = n.id AND coalesce(a.summary, a.ocrText, a.handwritingText, a.transcript) IS NOT NULL
        ), '')
      ), '') AS evidence_text,
      (
        SELECT json_group_array(
          json_object(
            'id', a.id,
            'filename', a.filename,
            'type', a.type,
            'available_locally', json(iif(a.availableLocally, 'true', 'false'))
          )
          ORDER BY a.id
        )
        FROM main.attachments a
        WHERE a.noteId = n.id
      ) AS evidence_attachments
    FROM main.notes n
  ),
  candidates AS (
    SELECT
      n.*,
      (
        WITH document(content) AS MATERIALIZED (
          SELECT lower(coalesce(n.title, '') || char(10) || coalesce(n.evidence_text, '') || char(10) || n.evidence_attachments)
        )
        SELECT json_group_array(term)
        FROM document CROSS JOIN terms
        WHERE instr(document.content, term) > 0
      ) AS matched_terms
    FROM records n
  )
SELECT
  'notes' AS source,
  id AS record_id,
  modifiedAt AS occurred_at,
  'modified' AS date_kind,
  NULL AS correspondent,
  title,
  evidence_text AS text,
  evidence_attachments AS attachments,
  matched_terms,
  json_object(
    'account_id', accountId,
    'folder_id', folderId,
    'locked', locked
  ) AS context
FROM candidates
WHERE json_array_length(matched_terms) > 0;
