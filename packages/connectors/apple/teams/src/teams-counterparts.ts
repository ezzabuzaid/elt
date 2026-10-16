import { counterparts } from '@workspace/connector-apple-connector/counterparts';

export const teamsCounterparts = counterparts(
  "In Teams, identifier is a Teams ID as messages, members and calls name people, 8:orgid:<objectId> for a person and 28:<id> for a bot, linked to the email address of the person's directory record (people.email) when Teams has looked them up; or the email address a meeting names an organizer or attendee by, which links to nothing. sent is a message the user wrote in a chat, one-on-one or group, once for each other member of it, and received a message someone else wrote in one: only what people and bots write counts, not Teams' own events (ThreadActivity/…, Event/…) or call recordings and transcripts (RichText/Media_Call…), and a deleted message still counts. member is a conversation shared with the user, a chat, meeting chat, team, channel or community, as its member list says or because they wrote, reacted or were @mentioned in it; the user's own notes are no conversation. outgoing-call is a call the user placed to them, answered-call one they placed to the user that connected and missed-call one that did not, missed or declined; attendee is anyone else on a call, or a meeting attendee other than its organizer and rooms (Resource); organizer is who organized a meeting; the user's own address (people.email of accounts.mri) is left out of both. self is the account's own Teams ID (accounts.mri). name is the directory's name for them (people.displayName), else the name their latest message, call or meeting gives (messages.senderName, call_logs.originatorName, meeting_attendees.name, meetings.organizerName). first_at and last_at come from messages.sentAt, meetings.startAt and call_logs.startedAt cut to milliseconds, and for member from the shared conversations' createdAt and lastMessageAt; occurrences counts messages, conversations, calls or meetings. context keys: for sent and received, direct and group (of those messages, how many were in one-on-one and in group chats); for member, direct, group, meeting and channel (shared one-on-one chats, group chats, meeting chats, and teams, channels or communities); for outgoing-call and answered-call, group (calls of more than two parties) and seconds (time connected); for missed-call, group and declined (calls the user declined); for attendee, meetings, calls and cancelled (meetings the organizer cancelled); for organizer, cancelled; self has none.",
  `WITH me AS (
    SELECT a.id AS "accountId", a.mri, lower(trim(p.email)) AS email
    FROM accounts a LEFT JOIN people p ON p."accountId" = a.id AND p.mri = a.mri
  ),
  kinds AS (
    SELECT "accountId", id, "createdAt", "lastMessageAt", CASE
      WHEN type = 'Chat' AND id LIKE '%@unq.gbl.spaces' THEN 'direct'
      WHEN type = 'Chat' THEN 'group'
      WHEN type = 'Meeting' THEN 'meeting'
      WHEN type IN ('Space', 'Topic', 'EngageCommunity') THEN 'channel' END AS kind
    FROM conversations
  ),
  written AS (
    SELECT m."accountId", m."conversationId", m."senderId", m."sentAt", k.kind
    FROM messages m JOIN kinds k ON k."accountId" = m."accountId" AND k.id = m."conversationId"
    WHERE m."senderId" IS NOT NULL
      AND m."messageType" NOT LIKE 'ThreadActivity/%'
      AND m."messageType" NOT LIKE 'Event/%'
      AND m."messageType" NOT LIKE 'RichText/Media_Call%'
  ),
  shared AS (
    SELECT "accountId", "conversationId", "memberId" AS id FROM conversation_members
    UNION SELECT "accountId", "conversationId", "senderId" FROM written
    UNION SELECT "accountId", "conversationId", "userId" FROM message_reactions
    UNION SELECT "accountId", "conversationId", "mentionedId" FROM message_mentions WHERE kind = 'person'
  ),
  calls AS (
    SELECT "accountId", id, "callType", state, strftime('%Y-%m-%dT%H:%M:%fZ', "startedAt") AS at,
      CASE WHEN direction = 'outgoing' THEN "targetId" ELSE "originatorId" END AS counterpart,
      CASE WHEN direction = 'outgoing' THEN 'outgoing-call' WHEN "connectedAt" IS NOT NULL THEN 'answered-call' ELSE 'missed-call' END AS relation,
      coalesce(CAST(round((julianday("endedAt") - julianday("connectedAt")) * 86400) AS INTEGER), 0) AS seconds
    FROM call_logs
  ),
  parties AS (
    SELECT "accountId", id AS "callLogId", "originatorId" AS id FROM call_logs WHERE "originatorId" IS NOT NULL
    UNION SELECT "accountId", id, "targetId" FROM call_logs WHERE "targetId" IS NOT NULL
    UNION SELECT "accountId", "callLogId", "participantId" FROM call_participants WHERE coalesce(type, 'default') = 'default'
  ),
  organizers AS (
    SELECT "accountId", id AS "meetingId", lower(trim("organizerAddress")) AS address FROM meetings WHERE "organizerAddress" IS NOT NULL
    UNION SELECT "accountId", "meetingId", lower(trim(address)) FROM meeting_attendees WHERE type = 'Organizer'
  ),
  records AS (
    SELECT 'sent' AS relation, w."accountId", 'app' AS identifier_type, r."memberId" AS identifier, w."sentAt" AS first, w."sentAt" AS last, w.kind, NULL AS amount
    FROM written w
    JOIN me ON me."accountId" = w."accountId" AND me.mri = w."senderId"
    JOIN conversation_members r ON r."accountId" = w."accountId" AND r."conversationId" = w."conversationId" AND r."memberId" <> me.mri
    WHERE w.kind IN ('direct', 'group')
    UNION ALL
    SELECT 'received', w."accountId", 'app', w."senderId", w."sentAt", w."sentAt", w.kind, NULL
    FROM written w JOIN me ON me."accountId" = w."accountId" AND me.mri <> w."senderId"
    WHERE w.kind IN ('direct', 'group')
    UNION ALL
    SELECT 'member', s."accountId", 'app', s.id, k."createdAt", k."lastMessageAt", k.kind, NULL
    FROM shared s
    JOIN kinds k ON k."accountId" = s."accountId" AND k.id = s."conversationId" AND k.kind IS NOT NULL
    JOIN me ON me."accountId" = s."accountId" AND me.mri <> s.id
    UNION ALL
    SELECT CASE WHEN p.id IS c.counterpart THEN c.relation ELSE 'attendee' END, c."accountId", 'app', p.id, c.at, c.at,
      CASE WHEN p.id IS NOT c.counterpart THEN 'call' WHEN c."callType" = 'multiParty' THEN 'group' END,
      CASE WHEN c.relation = 'missed-call' THEN c.state IS 'declined' ELSE c.seconds END
    FROM parties p
    JOIN calls c ON c."accountId" = p."accountId" AND c.id = p."callLogId"
    JOIN me ON me."accountId" = p."accountId" AND me.mri <> p.id
    UNION ALL
    SELECT 'organizer', o."accountId", 'email', o.address, m."startAt", m."startAt", 'meeting', m."isCancelled"
    FROM organizers o
    JOIN meetings m ON m."accountId" = o."accountId" AND m.id = o."meetingId"
    JOIN me ON me."accountId" = o."accountId" AND o.address IS NOT me.email
    UNION ALL
    SELECT 'attendee', a."accountId", 'email', lower(trim(a.address)), m."startAt", m."startAt", 'meeting', m."isCancelled"
    FROM meeting_attendees a
    JOIN meetings m ON m."accountId" = a."accountId" AND m.id = a."meetingId"
    JOIN me ON me."accountId" = a."accountId" AND lower(trim(a.address)) IS NOT me.email
    WHERE a.type IS NOT 'Organizer' AND a.type IS NOT 'Resource'
    UNION ALL
    SELECT 'self', "accountId", 'app', mri, NULL, NULL, NULL, NULL FROM me
  ),
  aliases AS (
    SELECT "accountId", identifier, name FROM (
      SELECT "accountId", identifier, name, row_number() OVER (PARTITION BY "accountId", identifier ORDER BY at DESC) AS latest
      FROM (
        SELECT "accountId", "senderId" AS identifier, "senderName" AS name, "sentAt" AS at FROM messages WHERE "senderName" IS NOT NULL
        UNION ALL SELECT "accountId", "originatorId", "originatorName", "startedAt" FROM call_logs WHERE "originatorName" IS NOT NULL
        UNION ALL SELECT "accountId", lower(trim("organizerAddress")), "organizerName", "startAt" FROM meetings WHERE "organizerName" IS NOT NULL
        UNION ALL SELECT a."accountId", lower(trim(a.address)), a.name, m."startAt"
          FROM meeting_attendees a JOIN meetings m ON m."accountId" = a."accountId" AND m.id = a."meetingId"
          WHERE a.name IS NOT NULL
      )
    ) WHERE latest = 1
  ),
  directory AS (
    SELECT "accountId", 'app' AS identifier_type, mri AS identifier, lower(trim(email)) AS email, "displayName" AS name FROM people
    UNION ALL
    SELECT "accountId", 'email', lower(trim(email)), NULL, max("displayName") FROM people WHERE email IS NOT NULL GROUP BY "accountId", lower(trim(email))
  )
  SELECT r.relation, r.identifier_type, r.identifier,
    CASE WHEN d.email IS NOT NULL THEN 'email' END AS linked_type, d.email AS linked_identifier,
    max(coalesce(d.name, a.name)) AS name,
    min(r.first) AS first_at, max(r.last) AS last_at, count(*) AS occurrences,
    CASE
      WHEN r.relation IN ('sent', 'received') THEN json_object(
        'direct', count(*) FILTER (WHERE r.kind = 'direct'),
        'group', count(*) FILTER (WHERE r.kind = 'group'))
      WHEN r.relation = 'member' THEN json_object(
        'direct', count(*) FILTER (WHERE r.kind = 'direct'),
        'group', count(*) FILTER (WHERE r.kind = 'group'),
        'meeting', count(*) FILTER (WHERE r.kind = 'meeting'),
        'channel', count(*) FILTER (WHERE r.kind = 'channel'))
      WHEN r.relation IN ('outgoing-call', 'answered-call') THEN json_object(
        'group', count(*) FILTER (WHERE r.kind = 'group'),
        'seconds', sum(r.amount))
      WHEN r.relation = 'missed-call' THEN json_object(
        'group', count(*) FILTER (WHERE r.kind = 'group'),
        'declined', sum(r.amount))
      WHEN r.relation = 'attendee' THEN json_object(
        'meetings', count(*) FILTER (WHERE r.kind = 'meeting'),
        'calls', count(*) FILTER (WHERE r.kind = 'call'),
        'cancelled', count(*) FILTER (WHERE r.kind = 'meeting' AND r.amount))
      WHEN r.relation = 'organizer' THEN json_object('cancelled', count(*) FILTER (WHERE r.amount))
    END AS context
  FROM records r
  LEFT JOIN directory d ON d."accountId" = r."accountId" AND d.identifier_type = r.identifier_type AND d.identifier = r.identifier
  LEFT JOIN aliases a ON a."accountId" = r."accountId" AND a.identifier = r.identifier
  GROUP BY r.relation, r.identifier_type, r.identifier, d.email`,
);
