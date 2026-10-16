import {
  counterparts,
  identifier,
} from '@workspace/connector-apple-connector/counterparts';

const handle = identifier('raw');

export const messagesCounterparts = counterparts(
  "In Messages, identifier is a handle (handles.id) in any service: a handle that recurs under iMessage and SMS is one identifier, and context names its services. A number stored with + keeps its digits; international digits without + (962…) gain one; any other number, such as a short code or a national number starting with 0, which needs its country to reach E.164, is its digits, as app; a sender name such as ArabBank stays as stored, trimmed, as app. received is each message a handle wrote (messages.handle where isFromMe is false), in any chat or in none. sent is each message the user wrote, once for every handle of its chat (chatHandles), linked through chatMessages or recoverableMessages: the user's own messages carry no handle, so one whose chat Messages no longer keeps names no one and shows in no row. A group chat is a chat with more than one handle; member is each handle of a group chat, once per chat, timed by the chat's messages. self is each phone or email the user's messages and chats are addressed through: messages.account and chats.accountLogin after their E: or P: prefix, and messages.destinationCallerId, whose SIM IDs are left out. Messages maps no identifier to another, so linked_type and linked_identifier are NULL. name is the title of the handle's one-to-one chat (chats.displayName), else a sender name itself; for anyone else Messages shows the Contacts name, which the Contacts counterparts give. first_at and last_at are messages.date. occurrences counts messages, reactions included; for member, group chats; for self, the messages and chats naming it. context keys: services, the sorted services (messages.service, chats.serviceName) of those records; for sent and received, direct and group, how many of those messages were in a one-to-one or a group chat (a received message whose chat is gone is in neither); for member, largest, the number of handles in the largest of those group chats.",
  `WITH spellings(raw) AS (
    SELECT handle FROM messages
    UNION SELECT "handleId" FROM chat_handles
    UNION SELECT substr(account, 3) FROM messages WHERE account GLOB '[EePp]:*'
    UNION SELECT "destinationCallerId" FROM messages
    UNION SELECT substr("accountLogin", 3) FROM chats WHERE "accountLogin" GLOB '[EePp]:*'
  ),
  identifiers AS (
    SELECT raw, ${handle.type} AS type, ${handle.identifier} AS value
    FROM spellings WHERE trim(raw) <> ''
  ),
  members AS (
    SELECT DISTINCT h."chatGuid" AS chat, i.type, i.value
    FROM chat_handles h JOIN identifiers i ON i.raw = h."handleId"
  ),
  sizes AS (SELECT chat, count(*) AS size FROM members GROUP BY chat),
  links AS (
    SELECT "chatGuid" AS chat, "messageGuid" AS message FROM chat_messages
    UNION SELECT "chatGuid", "messageGuid" FROM recoverable_messages
  ),
  received AS (
    SELECT i.type, i.value, m.date, m.service,
      (SELECT max(s.size) FROM links l JOIN sizes s ON s.chat = l.chat WHERE l.message = m.guid) AS size
    FROM messages m JOIN identifiers i ON i.raw = m.handle
    WHERE m."isFromMe" = 0
  ),
  sent AS (
    SELECT p.type, p.value, m.date, m.service, max(s.size) AS size
    FROM messages m
    JOIN links l ON l.message = m.guid
    JOIN members p ON p.chat = l.chat
    JOIN sizes s ON s.chat = l.chat
    WHERE m."isFromMe" = 1
    GROUP BY m.guid, p.type, p.value
  ),
  messaged AS (
    SELECT 'sent' AS relation, * FROM sent
    UNION ALL
    SELECT 'received', * FROM received
  ),
  groups AS (
    SELECT p.type, p.value, s.size, c."serviceName" AS service,
      (SELECT min(m.date) FROM links l JOIN messages m ON m.guid = l.message WHERE l.chat = p.chat) AS first_at,
      (SELECT max(m.date) FROM links l JOIN messages m ON m.guid = l.message WHERE l.chat = p.chat) AS last_at
    FROM members p JOIN sizes s ON s.chat = p.chat JOIN chats c ON c.guid = p.chat
    WHERE s.size > 1
  ),
  addressed AS (
    SELECT 'message ' || guid AS record, substr(account, 3) AS raw, date, service FROM messages WHERE account GLOB '[EePp]:*'
    UNION SELECT 'message ' || guid, "destinationCallerId", date, service FROM messages
    UNION SELECT 'chat ' || guid, substr("accountLogin", 3), NULL, "serviceName" FROM chats WHERE "accountLogin" GLOB '[EePp]:*'
  ),
  own AS (
    SELECT DISTINCT a.record, i.type, i.value, a.date, a.service
    FROM addressed a JOIN identifiers i ON i.raw = a.raw
    WHERE i.type IN ('phone', 'email')
  ),
  names AS (
    SELECT type, value, coalesce(max(title), max(sender)) AS name FROM (
      SELECT p.type, p.value, nullif(trim(c."displayName"), '') AS title, NULL AS sender
      FROM members p JOIN sizes s ON s.chat = p.chat AND s.size = 1 JOIN chats c ON c.guid = p.chat
      UNION ALL
      SELECT type, value, NULL, value FROM identifiers WHERE type = 'app' AND value GLOB '*[^0-9]*'
    ) GROUP BY type, value
  ),
  relations AS (
    SELECT relation, type, value, min(date) AS first_at, max(date) AS last_at, count(*) AS occurrences,
      json_object(
        'services', json_group_array(DISTINCT service ORDER BY service),
        'direct', count(CASE WHEN size = 1 THEN 1 END),
        'group', count(CASE WHEN size > 1 THEN 1 END)
      ) AS context
    FROM messaged GROUP BY relation, type, value
    UNION ALL
    SELECT 'member', type, value, min(first_at), max(last_at), count(*),
      json_object('services', json_group_array(DISTINCT service ORDER BY service), 'largest', max(size))
    FROM groups GROUP BY type, value
    UNION ALL
    SELECT 'self', type, value, min(date), max(date), count(*),
      json_object('services', json_group_array(DISTINCT service ORDER BY service))
    FROM own GROUP BY type, value
  )
  SELECT r.relation, r.type AS identifier_type, r.value AS identifier, NULL AS linked_type, NULL AS linked_identifier,
    n.name, r.first_at, r.last_at, r.occurrences, r.context
  FROM relations r LEFT JOIN names n ON n.type = r.type AND n.value = r.value`,
);
