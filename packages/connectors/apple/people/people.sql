-- The people model: everyone the user has dealt with in the connected apps, built on read from each import's counterparts view. Load it on a connection that has every one of these imports attached under its connector's name: contacts, messages, "call-history", mail, whatsapp, slack, teams, calendar. It creates temporary views only and stores nothing.
-- A person is a Contacts card when a card holds one of their identifiers, else one identifier: the phone number, email address or app identifier the apps name them by, an app identifier counting as the phone or email the app maps it to. Cards never merge: an identifier on two cards belongs to both, tagged shared.
--
-- all_counterparts: Every connector's counterparts rows, with the connector that recorded each.
-- all_counterparts.connector: The connector, such as whatsapp.
-- all_counterparts.relation, identifier_type, identifier, linked_type, linked_identifier, name, first_at, last_at, occurrences, context: As the connector's counterparts view describes them.
--
-- person_relations: One row per counterparts row and the person it belongs to; a row whose identifier two cards hold appears once for each card.
-- person_relations.person_id: The person (people.id).
-- person_relations.connector: The connector that recorded the relation.
-- person_relations.relation: How that app records the user dealing with them, such as sent or missed-call.
-- person_relations.identifier_type: phone, email or app.
-- person_relations.identifier: The identifier the app names them by.
-- person_relations.linked_type: phone, email or app when the app maps identifier to another identifier of theirs; NULL otherwise.
-- person_relations.linked_identifier: That identifier; NULL when none.
-- person_relations.name: The name the app shows for them; NULL when none.
-- person_relations.first_at: The earliest time the app recorded for the relation, ISO 8601 UTC to the millisecond, or a date (YYYY-MM-DD) when the app records only a date; NULL when the app records no time.
-- person_relations.last_at: The latest such time; NULL when the app records no time.
-- person_relations.occurrences: How many of the app's records show the relation.
-- person_relations.context: The connector's JSON details, as its counterparts view describes them.
-- person_relations.shared: 1 when two or more cards hold the identifier the relation is matched by, else 0.
--
-- person_identifiers: One row per identifier a person is known by, and the connector that knows it.
-- person_identifiers.person_id: The person (people.id).
-- person_identifiers.type: phone, email or app.
-- person_identifiers.value: The identifier.
-- person_identifiers.connector: The connector that knows them by it.
--
-- people: One row per person.
-- people.id: The card ID (contacts.id) when the person is a card, else the identifier they are matched by, such as +962791234567, someone@example.com, a Slack member ID or an SMS sender name.
-- people.name: The card's name; else the first name found in Slack or Teams, WhatsApp, Call History, Mail and then the other apps, the most recent first; NULL when no app shows one.
-- people.card_id: The card ID when the person is a card; NULL otherwise.
-- people.is_self: 1 when the person holds one of the user's own identifiers, else 0.
-- people.tags: JSON array of how the user dealt with them, each <connector>:<relation> such as whatsapp:sent or call-history:missed-call, plus shared when another card holds one of their identifiers; sorted.
-- people.first_at: The earliest time any app recorded dealing with them, ISO 8601 UTC; NULL when no app records a time, as for a card alone.
-- people.last_at: The latest such time; NULL when no app records a time.
CREATE TEMP VIEW all_counterparts AS
SELECT 'contacts' AS connector, relation, identifier_type, identifier, linked_type, linked_identifier, name, first_at, last_at, occurrences, context FROM contacts.counterparts
UNION ALL SELECT 'messages', relation, identifier_type, identifier, linked_type, linked_identifier, name, first_at, last_at, occurrences, context FROM messages.counterparts
UNION ALL SELECT 'call-history', relation, identifier_type, identifier, linked_type, linked_identifier, name, first_at, last_at, occurrences, context FROM "call-history".counterparts
UNION ALL SELECT 'mail', relation, identifier_type, identifier, linked_type, linked_identifier, name, first_at, last_at, occurrences, context FROM mail.counterparts
UNION ALL SELECT 'whatsapp', relation, identifier_type, identifier, linked_type, linked_identifier, name, first_at, last_at, occurrences, context FROM whatsapp.counterparts
UNION ALL SELECT 'slack', relation, identifier_type, identifier, linked_type, linked_identifier, name, first_at, last_at, occurrences, context FROM slack.counterparts
UNION ALL SELECT 'teams', relation, identifier_type, identifier, linked_type, linked_identifier, name, first_at, last_at, occurrences, context FROM teams.counterparts
UNION ALL SELECT 'calendar', relation, identifier_type, identifier, linked_type, linked_identifier, name, first_at, last_at, occurrences, context FROM calendar.counterparts;

CREATE TEMP VIEW person_relations AS
WITH
  -- The identifier a row is matched by: the phone or email the app maps it
  -- to, else its own.
  keyed AS (
    SELECT *, coalesce(linked_identifier, identifier) AS key FROM all_counterparts
  ),
  cards AS MATERIALIZED (
    SELECT DISTINCT identifier AS card, linked_identifier AS key FROM contacts.counterparts
    WHERE relation = 'card' AND linked_identifier IS NOT NULL
  ),
  holders AS (SELECT key, count(*) AS cards FROM cards GROUP BY key)
SELECT
  -- A card's own rows are the card; any other row is each card that holds its
  -- key, else the key.
  CASE WHEN k.connector = 'contacts' THEN k.identifier ELSE coalesce(c.card, k.key) END AS person_id,
  k.connector, k.relation, k.identifier_type, k.identifier, k.linked_type, k.linked_identifier,
  k.name,
  -- One form for every app's instants, to the millisecond, so they compare as
  -- text; a date the app records without a time stays a date.
  CASE WHEN k.first_at GLOB '????-??-??T*' THEN strftime('%Y-%m-%dT%H:%M:%fZ', k.first_at) ELSE k.first_at END AS first_at,
  CASE WHEN k.last_at GLOB '????-??-??T*' THEN strftime('%Y-%m-%dT%H:%M:%fZ', k.last_at) ELSE k.last_at END AS last_at,
  k.occurrences, k.context,
  coalesce(h.cards, 0) > 1 AS shared
FROM keyed k
LEFT JOIN cards c ON k.connector <> 'contacts' AND c.key = k.key
LEFT JOIN holders h ON h.key = k.key;

CREATE TEMP VIEW person_identifiers AS
SELECT person_id, identifier_type AS type, identifier AS value, connector FROM person_relations
UNION
SELECT person_id, linked_type, linked_identifier, connector FROM person_relations WHERE linked_identifier IS NOT NULL;

CREATE TEMP VIEW people AS
WITH
  relations AS MATERIALIZED (SELECT * FROM person_relations),
  named AS (
    SELECT person_id, name, row_number() OVER (
      PARTITION BY person_id
      ORDER BY CASE connector WHEN 'contacts' THEN 0 WHEN 'slack' THEN 1 WHEN 'teams' THEN 1 WHEN 'whatsapp' THEN 2 WHEN 'call-history' THEN 3 WHEN 'mail' THEN 4 ELSE 5 END,
        last_at DESC
    ) AS rank
    FROM relations WHERE name IS NOT NULL
  ),
  tagged AS (
    SELECT person_id, connector || ':' || relation AS tag FROM relations
    UNION
    SELECT person_id, 'shared' FROM relations WHERE shared
  ),
  tags AS (SELECT person_id, json_group_array(tag ORDER BY tag) AS tags FROM tagged GROUP BY person_id),
  summary AS (
    SELECT person_id, max(connector = 'contacts') AS carded, max(relation = 'self') AS is_self,
      min(first_at) AS first_at, max(last_at) AS last_at
    FROM relations GROUP BY person_id
  )
SELECT s.person_id AS id, n.name, CASE WHEN s.carded THEN s.person_id END AS card_id,
  s.is_self, t.tags, s.first_at, s.last_at
FROM summary s
JOIN tags t ON t.person_id = s.person_id
LEFT JOIN named n ON n.person_id = s.person_id AND n.rank = 1;
