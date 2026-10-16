import {
  counterparts,
  identifier,
} from '@workspace/connector-apple-connector/counterparts';

// A card number with no E.164 form, such as a short code, and a card address,
// in the form every app's counterparts write them.
const number = identifier('p."fullNumber"');
const address = identifier('e.address');

export const contactsCounterparts = counterparts(
  "In Contacts, identifier is a card (contacts.id) and linked_identifier each of its phone numbers (phone_numbers.e164) and email addresses; a number with no E.164 form, such as a short code, is linked as every app writes it, an app identifier of its digits; a card with none has one row whose linked_identifier is NULL. relation is card for every card and also self for the card a container names as the user's own (containers.meContactId). name is the card's first and last name, else its organization, else its nickname. Contacts records no time, so first_at and last_at are NULL; occurrences is 1 and context NULL.",
  `WITH links AS (
    SELECT p."contactId", 'phone' AS type, p.e164 AS value FROM phone_numbers p WHERE p.e164 IS NOT NULL
    UNION
    SELECT p."contactId", ${number.type}, ${number.identifier} FROM phone_numbers p WHERE p.e164 IS NULL AND trim(p."fullNumber") <> ''
    UNION
    SELECT e."contactId", ${address.type}, ${address.identifier} FROM email_addresses e WHERE trim(e.address) <> ''
  ),
  cards AS (
    SELECT c.id, coalesce(nullif(trim(coalesce(c."firstName", '') || ' ' || coalesce(c."lastName", '')), ''), c.organization, c.nickname) AS name
    FROM contacts c
  ),
  relations AS (
    SELECT 'card' AS relation, id, name FROM cards
    UNION ALL
    SELECT 'self', id, name FROM cards WHERE id IN (SELECT "meContactId" FROM containers)
  )
  SELECT r.relation, 'app' AS identifier_type, r.id AS identifier, l.type AS linked_type, l.value AS linked_identifier,
    r.name, NULL AS first_at, NULL AS last_at, 1 AS occurrences, NULL AS context
  FROM relations r LEFT JOIN links l ON l."contactId" = r.id`,
);
