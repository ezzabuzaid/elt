import { counterparts } from '@workspace/connector-apple-connector/counterparts';

export const slackCounterparts = counterparts(
  "In Slack, identifier is a member as <workspace ID>:<member ID> (workspaces.id, members.id), such as T0123ABCD:U0123ABCD: Slack gives a member ID only within its workspace, and gives some, such as Slackbot's USLACKBOT, in every workspace. A bot that posts without a member of its own, such as an incoming webhook, is <workspace ID>:<bot ID> (bots.id). linked_identifier is the member's email (members.email), which one person's members in several workspaces share; NULL when Slack shows none. The records are channel messages and thread replies (messages, thread_replies), which Slack keeps only once it has loaded them on this Mac, in the conversations the user belongs to (channels.isMember): a public channel the user has not joined puts nobody in touch with the user. relation is sent for the user's messages in a direct message with them; received for their messages in a direct message with the user, an app's posts in the user's own direct message among them; member for the other person of a direct message, the members Slack lists for a conversation (channel_members) and whoever wrote in a group direct message or channel; and self for the member each workspace is signed in as (workspaces.userId), which appears in no other relation. name is the member's real name, else display name, else username, else the bot's name. first_at, last_at and occurrences are the earliest and latest sent time and the count of the messages behind the relation: for member, every message in the conversations the user shares with them; for self, the messages the user wrote. occurrences is 0 and the times NULL when Slack holds none. context has workspace (the workspace's name), isBot (true for a bot, Slackbot or Slack's own member USLACK, which Slack does not mark bots; NULL for an author Slack keeps no member for) and conversations (how many conversations of each kind, im, mpim, private or public, the relation comes from).",
  `WITH bot_users AS (
    SELECT "workspaceId", "botId", min(id) AS "memberId" FROM members GROUP BY "workspaceId", "botId"
  ),
  posts AS (
    SELECT p."workspaceId", p."channelId", p."sentAt", coalesce(p."userId", b."memberId", p."botId") AS author
    FROM (
      SELECT "workspaceId", "channelId", "sentAt", "userId", "botId" FROM messages
      UNION ALL
      SELECT "workspaceId", "channelId", "sentAt", "userId", "botId" FROM thread_replies
    ) p
    LEFT JOIN bot_users b ON b."workspaceId" = p."workspaceId" AND b."botId" = p."botId"
  ),
  joined AS (
    SELECT "workspaceId", id AS "channelId", kind, "imUserId" FROM channels WHERE "isMember" = 1
  ),
  shared AS (
    SELECT "workspaceId", "channelId", kind, "imUserId" AS "memberId" FROM joined WHERE kind = 'im'
    UNION
    SELECT j."workspaceId", j."channelId", j.kind, cm."memberId"
    FROM joined j JOIN channel_members cm ON cm."workspaceId" = j."workspaceId" AND cm."channelId" = j."channelId"
    UNION
    SELECT j."workspaceId", j."channelId", j.kind, p.author
    FROM joined j JOIN posts p ON p."workspaceId" = j."workspaceId" AND p."channelId" = j."channelId"
    WHERE j.kind <> 'im'
  ),
  relations AS (
    SELECT CASE WHEN p.author = w."userId" THEN 'sent' ELSE 'received' END AS relation, j."workspaceId",
      CASE WHEN p.author = w."userId" THEN j."imUserId" ELSE p.author END AS "memberId",
      j."channelId", j.kind, p."sentAt"
    FROM joined j
    JOIN workspaces w ON w.id = j."workspaceId"
    JOIN posts p ON p."workspaceId" = j."workspaceId" AND p."channelId" = j."channelId"
    WHERE j.kind = 'im'
    UNION ALL
    SELECT 'member', s."workspaceId", s."memberId", s."channelId", s.kind, p."sentAt"
    FROM shared s LEFT JOIN posts p ON p."workspaceId" = s."workspaceId" AND p."channelId" = s."channelId"
    UNION ALL
    SELECT 'self', w.id, w."userId", p."channelId", c.kind, p."sentAt"
    FROM workspaces w
    LEFT JOIN posts p ON p."workspaceId" = w.id AND p.author = w."userId"
    LEFT JOIN channels c ON c."workspaceId" = p."workspaceId" AND c.id = p."channelId"
  )
  SELECT r.relation, 'app' AS identifier_type, r."workspaceId" || ':' || r."memberId" AS identifier,
    CASE WHEN m.email IS NOT NULL THEN 'email' END AS linked_type, lower(trim(m.email)) AS linked_identifier,
    coalesce(m."realName", m."displayName", m.name, b.name) AS name,
    min(r."sentAt") AS first_at, max(r."sentAt") AS last_at, count(r."sentAt") AS occurrences,
    json_object(
      'workspace', w.name,
      'isBot', CASE
        WHEN m."isBot" = 1 OR m.id IN ('USLACKBOT', 'USLACK') OR (m.id IS NULL AND b.id IS NOT NULL) THEN json('true')
        WHEN m.id IS NOT NULL THEN json('false')
      END,
      'conversations', json_patch('{}', json_object(
        'im', nullif(count(DISTINCT CASE WHEN r.kind = 'im' THEN r."channelId" END), 0),
        'mpim', nullif(count(DISTINCT CASE WHEN r.kind = 'mpim' THEN r."channelId" END), 0),
        'private', nullif(count(DISTINCT CASE WHEN r.kind = 'private' THEN r."channelId" END), 0),
        'public', nullif(count(DISTINCT CASE WHEN r.kind = 'public' THEN r."channelId" END), 0)
      ))
    ) AS context
  FROM relations r
  JOIN workspaces w ON w.id = r."workspaceId"
  LEFT JOIN members m ON m."workspaceId" = r."workspaceId" AND m.id = r."memberId"
  LEFT JOIN bots b ON b."workspaceId" = r."workspaceId" AND b.id = r."memberId"
  WHERE r.relation = 'self' OR r."memberId" <> w."userId"
  GROUP BY r.relation, r."workspaceId", r."memberId"`,
);
