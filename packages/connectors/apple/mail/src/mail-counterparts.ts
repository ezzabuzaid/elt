import { counterparts } from '@workspace/connector-apple-connector/counterparts';

export const mailCounterparts = counterparts(
  "In Mail, identifier is an address of the index (addresses.address), trimmed and lowercase, since Mail compares addresses without case: spellings that differ only in case are one row. identifier_type is email when it holds an @, else app, such as an Exchange directory name (/o=ExchangeLabs/…/cn=…) or a bare name typed as a recipient; an empty group such as 'undisclosed-recipients:;' names no one and gives no row. The user's own addresses are the emailAddresses of the accounts, and a message is the user's when its sender is one of them, whatever mailbox holds it, so a saved draft counts too. relation is sent for each To recipient (recipients.type 0) of the user's messages and cc for each Cc recipient (type 1, and any other code, which a live store did not hold); received for the sender of every other message; self for each of the user's own addresses, over the messages sent from it, with occurrences 0 when none was. The other recipients of a message the user received are no row: the sender chose them, and a bulk message lists hundreds; once the user writes to them, they are sent or cc. A message whose index row has no sender, such as an Exchange draft, gives no row. first_at and last_at are the earliest and latest date Mail received those messages (messages.dateReceived, else dateSent), as a sender's Date header can hold any date. occurrences counts the messages. name is the display name (addresses.comment) on most of them, the latest on a tie, NULL when none has one. Mail maps an address to no other, so linked_type and linked_identifier are NULL. context has conversations: how many Mail conversations (messages.conversationId) the messages are in.",
  `WITH own AS (
    SELECT DISTINCT lower(trim(e.value)) AS identifier
    FROM accounts a, json_each(a.properties, '$.emailAddresses') e
  ),
  people AS (
    SELECT id, lower(trim(address)) AS identifier, nullif(trim(comment), '') AS name
    FROM addresses
    WHERE address LIKE '%@%' OR trim(address) NOT LIKE '%:%;'
  ),
  authored AS (
    SELECT m.id AS message, m."conversationId" AS conversation, coalesce(m."dateReceived", m."dateSent") AS at,
      p.identifier, p.name, p.identifier IN (SELECT identifier FROM own) AS mine
    FROM messages m JOIN people p ON p.id = m.sender
  ),
  involvements AS (
    SELECT iif(mine, 'self', 'received') AS relation, identifier, name, message, conversation, at FROM authored
    UNION ALL
    SELECT iif(r.type = 0, 'sent', 'cc'), p.identifier, p.name, a.message, a.conversation, a.at
    FROM authored a JOIN recipients r ON r.message = a.message JOIN people p ON p.id = r.address
    WHERE a.mine
  ),
  names AS (
    SELECT relation, identifier, name,
      row_number() OVER (PARTITION BY relation, identifier ORDER BY count(DISTINCT message) DESC, max(at) DESC, name) AS rank
    FROM involvements
    WHERE name IS NOT NULL
    GROUP BY relation, identifier, name
  ),
  totals AS (
    SELECT relation, identifier, min(at) AS first_at, max(at) AS last_at,
      count(DISTINCT message) AS occurrences, count(DISTINCT conversation) AS conversations
    FROM involvements
    GROUP BY relation, identifier
    UNION ALL
    SELECT 'self', identifier, NULL, NULL, 0, 0 FROM own
    WHERE identifier NOT IN (SELECT identifier FROM authored WHERE mine)
  )
  SELECT t.relation, iif(t.identifier LIKE '%@%', 'email', 'app') AS identifier_type, t.identifier,
    NULL AS linked_type, NULL AS linked_identifier, n.name, t.first_at, t.last_at, t.occurrences,
    json_object('conversations', t.conversations) AS context
  FROM totals t
  LEFT JOIN names n ON n.relation = t.relation AND n.identifier = t.identifier AND n.rank = 1`,
);
