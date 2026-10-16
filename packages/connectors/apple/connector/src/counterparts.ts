import type { SQLiteView } from '@workspace/elt-sqlite';

// What every connector's counterparts view says about the people its app
// records the user dealing with. Each connector translates its app's own
// shape into these columns, so a reader such as the people model unions the
// views of several imports without knowing any app.
const columns = {
  relation:
    "How the app records the user dealing with them: sent (the user wrote to them: a message, or mail the user addressed To them), received (they wrote to the user), cc (mail the user copied them on), outgoing-call (the user called them), answered-call (they called and the user answered), missed-call (they called and nobody answered), member (in a group, channel or chat with the user), attendee (on an event with the user), organizer (organized an event the user is on), card (on one of the user's Contacts cards) or self (one of the user's own identifiers). Prefix it with the connector's name for a tag, such as whatsapp:sent.",
  identifier_type:
    'phone, email or app. A phone is in E.164 form, such as +962791234567. An email is trimmed and lowercase. An app identifier is one only this app gives, such as a WhatsApp LID, a Slack member ID, a Teams ID, a Contacts card ID or an SMS sender name.',
  identifier: 'The identifier, in the form identifier_type gives.',
  linked_type:
    'phone, email or app when the app maps identifier to another identifier of the same person, such as a WhatsApp LID to its phone number or a Contacts card to each of its numbers and addresses; app is an SMS short code a card holds, which has no E.164 form. NULL when the app maps it to none.',
  linked_identifier:
    'The identifier that identifier maps to, in the form linked_type gives: a phone in E.164, an email lowercase, a short code as its digits; NULL when the app maps it to none. Identifiers of one person share it across apps.',
  name: 'The name the app shows for them, such as a chat title or a caller name; NULL when it shows none.',
  first_at:
    'The earliest time the app recorded for this relation, as an ISO 8601 UTC timestamp; NULL when the app records no time, as for a Contacts card.',
  last_at:
    'The latest time the app recorded for this relation, as an ISO 8601 UTC timestamp; NULL when the app records no time.',
  occurrences:
    'How many records of the app show this relation, such as messages sent or calls missed.',
  context:
    'JSON object with what the relation keeps of the app, such as the chat kind or an event size; its keys are the connector’s own and the view description names them. NULL when there is nothing to add.',
};

// SQL for the identifier_type and identifier of a phone number, address or
// handle as an app stores it, so the same number or address is one string
// whichever app recorded it: an email trimmed, lowercase and without mailto:,
// a number with + or of 8 to 15 digits that do not start with 0 as a phone in
// E.164, any other number (a short code, or a national number that needs its
// country to reach E.164) as app digits, anything else as app, trimmed.
export function identifier(value: string): {
  readonly type: string;
  readonly identifier: string;
} {
  // The digits of a number written with spaces, dashes, dots or parentheses.
  const digits = `replace(replace(replace(replace(replace(trim(${value}), ' ', ''), '-', ''), '(', ''), ')', ''), '.', '')`;
  const email = `trim(${value}) LIKE '%@%'`;
  const plus = `(${digits} GLOB '+[0-9]*' AND substr(${digits}, 2) NOT GLOB '*[^0-9]*')`;
  const international = `(${digits} GLOB '[1-9]*' AND ${digits} NOT GLOB '*[^0-9]*' AND length(${digits}) BETWEEN 8 AND 15)`;
  const number = `(${digits} GLOB '[0-9]*' AND ${digits} NOT GLOB '*[^0-9]*')`;
  return {
    type: `CASE WHEN ${email} THEN 'email' WHEN ${plus} OR ${international} THEN 'phone' ELSE 'app' END`,
    identifier: `CASE WHEN ${email} THEN CASE WHEN lower(trim(${value})) LIKE 'mailto:%' THEN substr(lower(trim(${value})), 8) ELSE lower(trim(${value})) END
      WHEN ${plus} THEN ${digits} WHEN ${international} THEN '+' || ${digits} WHEN ${number} THEN ${digits} ELSE trim(${value}) END`,
  };
}

// One connector's counterparts view: description names what each relation is
// in the app and the keys of context; query yields exactly the columns above,
// over the views of the connector's own import.
export function counterparts(description: string, query: string): SQLiteView {
  return {
    name: 'counterparts',
    description: `One row per relation, identifier and linked_identifier: how the app records the user dealing with someone, so a reader finds everyone the user dealt with in this app and, with the counterparts of other connectors, across apps. ${description}`,
    columns,
    query,
  };
}
