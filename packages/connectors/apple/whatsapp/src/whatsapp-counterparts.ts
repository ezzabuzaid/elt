import { counterparts } from '@workspace/connector-apple-connector/counterparts';

// A JID's user part, such as the number of 15550001001@s.whatsapp.net.
const user = (jid: string) => `substr(${jid}, 1, instr(${jid}, '@') - 1)`;

// A phone JID whose number has an E.164 form: 8 to 15 digits, without the
// leading 0 of a national number. WhatsApp's own 0@s.whatsapp.net has none.
const e164 = (jid: string) =>
  `(${jid} LIKE '%@s.whatsapp.net' AND ${user(jid)} NOT GLOB '*[^0-9]*' AND ${user(jid)} NOT GLOB '0*' AND length(${user(jid)}) BETWEEN 8 AND 15)`;

const identifierType = (jid: string) =>
  `CASE WHEN ${e164(jid)} THEN 'phone' ELSE 'app' END`;

const identifier = (jid: string) =>
  `CASE WHEN ${e164(jid)} THEN '+' || ${user(jid)} ELSE ${jid} END`;

// A chat title with a character other than the digits, spaces, signs,
// brackets, dashes and direction marks of a number WhatsApp formats, such as
// +1 555 010 0199 between direction marks, its title for a person missing
// from the address book.
const titled = `"partnerName" GLOB '*[^0-9' || char(32, 160, 43, 40, 41, 8206, 8207, 8209, 8234, 8236, 45) || ']*'`;

const description =
  "In WhatsApp, a person is a JID. A phone JID, <number>@s.whatsapp.net, is identifier as a phone in E.164; a LID, <n>@lid, is identifier as app and links to the phone number WhatsApp holds for it (users.phoneNumber); any other JID, such as WhatsApp's own 0@s.whatsapp.net or a bot's …@bot, is app as WhatsApp stores it. sent and received are the messages this account sent to or received from a one-person chat (chats.sessionType 0), by messages.isFromMe, notices among them; received also counts the statuses a contact posted, which WhatsApp keeps as a chat of their own (sessionType 3, <number>@status or <LID>@lid.status), and context.statuses says how many; context is NULL when it holds none. member is everyone a group (sessionType 1 or 4) or a broadcast list (sessionType 2, the status audience status@broadcast among them) lists in group_members, including those who left: occurrences counts the chats that list them, context.groups and context.broadcasts how many of each kind, context.left how many list them as gone, and first_at and last_at are the first and last message they sent there, NULL when they sent none. outgoing-call, answered-call and missed-call are the calls with each participant (call_participants), by the incoming and missed flags of the call's log entry; a group call counts for each participant; context.seconds is the calls' total duration, context.video and context.group how many were video or group calls. self is this account: the recipients of the receipts WhatsApp keeps for the messages it received in one-person chats, which only the account's own devices send; occurrences counts those receipts. The account also appears in the other relations, as in the groups it is in. A channel (sessionType 5), the status pseudo-chat and a broadcast list's own messages name no person and add no row. name is the chat's title (chats.partnerName) unless it is only the number formatted, else the address book name (contacts.fullName), else the name the person gave WhatsApp (push_names.pushName), else the name a group shows (group_members.contactName). An import narrowed to chats holds no users, calls, contacts or push names: its LIDs link to no phone, it has no call relations, and names come from chats and groups.";

// WhatsApp's counterparts, from the streams this import copied.
export function whatsappCounterparts(copied: ReadonlySet<string>) {
  const phones = copied.has('users')
    ? `SELECT lid, "phoneNumber" || '@s.whatsapp.net' AS jid FROM users WHERE "phoneNumber" IS NOT NULL`
    : 'SELECT NULL AS lid, NULL AS jid WHERE 0';
  const relations = [
    `SELECT CASE m."isFromMe" WHEN 1 THEN 'sent' ELSE 'received' END AS relation, p.jid,
      min(m."messageDate") AS first_at, max(m."messageDate") AS last_at, count(*) AS occurrences,
      CASE WHEN sum(p.status) > 0 THEN json_object('statuses', sum(p.status)) END AS context
    FROM messages m JOIN people_chats p ON p.chat = m."chatJid"
    GROUP BY 1, 2`,
    `SELECT 'member', g."memberJid", min(s.first_at), max(s.last_at), count(*),
      json_object('groups', sum(c."sessionType" IN (1, 4)), 'broadcasts', sum(c."sessionType" = 2), 'left', sum(g."isActive" = 0))
    FROM group_members g JOIN chats c ON c.jid = g."groupJid"
    LEFT JOIN said s ON s."chatJid" = g."groupJid" AND s."groupMemberJid" = g."memberJid"
    GROUP BY 2`,
    ...(copied.has('calls') && copied.has('callParticipants')
      ? [
          `SELECT CASE WHEN c.incoming = 0 THEN 'outgoing-call' WHEN c.missed = 1 THEN 'missed-call' ELSE 'answered-call' END,
            p.jid, min(c.date), max(c.date), count(*),
            json_object('seconds', CAST(round(total(c.duration)) AS INTEGER), 'video', sum(c.video), 'group', sum(c."groupJid" IS NOT NULL))
          FROM call_participants p JOIN calls c ON c."callId" = p."callId"
          GROUP BY 1, 2`,
        ]
      : []),
    `SELECT 'self', r."recipientJid", min(coalesce(r."deliveredAt", r."readAt", r."playedAt")),
      max(coalesce(r."deliveredAt", r."readAt", r."playedAt")), count(*), NULL
    FROM message_receipts r JOIN chats c ON c.jid = r."chatJid"
    WHERE c."sessionType" = 0 AND r."messageIsFromMe" = 0
    GROUP BY 2`,
  ];
  const names = [
    `SELECT jid, "partnerName" AS name, 1 AS rank FROM people_chats WHERE ${titled}`,
    ...(copied.has('contacts')
      ? [
          `SELECT "whatsappId", "fullName", 2 FROM contacts`,
          `SELECT lid, "fullName", 2 FROM contacts`,
        ]
      : []),
    ...(copied.has('pushNames')
      ? [`SELECT jid, "pushName", 3 FROM push_names`]
      : []),
    `SELECT "memberJid", "contactName", 4 FROM group_members`,
  ];
  return counterparts(
    description,
    `WITH phones AS (${phones}),
    people_chats AS (
      SELECT jid AS chat, "partnerName", "sessionType" = 3 AS status,
        CASE "sessionType" WHEN 3 THEN replace(replace(jid, '@lid.status', '@lid'), '@status', '@s.whatsapp.net') ELSE jid END AS jid
      FROM chats WHERE "sessionType" IN (0, 3)
    ),
    said AS (
      SELECT "chatJid", "groupMemberJid", min("messageDate") AS first_at, max("messageDate") AS last_at
      FROM messages WHERE "groupMemberJid" IS NOT NULL GROUP BY 1, 2
    ),
    relations AS (${relations.join(' UNION ALL ')}),
    names AS (
      SELECT jid, name FROM (
        SELECT jid, name, row_number() OVER (PARTITION BY jid ORDER BY rank, name) AS n
        FROM (${names.join(' UNION ALL ')}) WHERE trim(name) <> ''
      ) WHERE n = 1
    )
    SELECT r.relation, ${identifierType('r.jid')} AS identifier_type, ${identifier('r.jid')} AS identifier,
      CASE WHEN l.jid IS NOT NULL THEN ${identifierType('l.jid')} END AS linked_type,
      CASE WHEN l.jid IS NOT NULL THEN ${identifier('l.jid')} END AS linked_identifier,
      n.name, r.first_at, r.last_at, r.occurrences, r.context
    FROM relations r
    LEFT JOIN phones l ON l.lid = r.jid
    LEFT JOIN names n ON n.jid = r.jid`,
  );
}
