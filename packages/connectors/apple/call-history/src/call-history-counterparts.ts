import {
  counterparts,
  identifier,
} from '@workspace/connector-apple-connector/counterparts';

const party = identifier('p.raw');

export const callHistoryCounterparts = counterparts(
  'In Call History, each call is one record. relation is outgoing-call for a call the user placed, answered or not (callhistoryd stores answered for incoming calls only), answered-call for an incoming call the user answered and missed-call for an incoming call nobody answered; a call that stores no direction counts as incoming, and one that stores no answer as not answered. identifier is each other party the call names (call_participants.normalizedValue, else value), several for a group FaceTime call; a call with no participant falls back to its address (calls.address), and a call with neither, such as one from a withheld number, has no row. A value with @ is an email. A number with + or of 8 to 15 digits that do not start with 0 is a phone in E.164; any other number is app as its digits, such as a short code or a number in national form, which starts with 0 and needs a country SQL does not know to reach E.164; any other value is app as stored. relation is also self for each identifier the user placed a call from (calls.initiatorNormalizedValue, else initiatorValue, of an outgoing call), which callhistoryd records on some calls only, such as FaceTime calls. Call History maps no identifier to another, so linked_type and linked_identifier are NULL. name is the name the latest of the calls showed (calls.name), and NULL for self. first_at and last_at are the earliest and latest calls.startedAt; occurrences counts the calls. context has kinds, the number of calls of each kind (phone, faceTimeVideo, faceTimeAudio, or other for a kind this reader does not know), and seconds, their total duration rounded to whole seconds.',
  `WITH parties AS (
    SELECT p."callId" AS id, coalesce(p."normalizedValue", p.value) AS raw, 0 AS self
    FROM call_participants p
    UNION ALL
    SELECT c.id, c.address, 0 FROM calls c
    WHERE NOT EXISTS (SELECT 1 FROM call_participants p WHERE p."callId" = c.id)
    UNION ALL
    SELECT c.id, coalesce(c."initiatorNormalizedValue", c."initiatorValue"), 1 FROM calls c
    WHERE c.outgoing
  ),
  identified AS (
    SELECT
      CASE WHEN p.self THEN 'self' WHEN c.outgoing THEN 'outgoing-call' WHEN c.answered THEN 'answered-call' ELSE 'missed-call' END AS relation,
      ${party.type} AS identifier_type, ${party.identifier} AS identifier,
      CASE WHEN NOT p.self THEN c.name END AS name,
      c."startedAt", c.duration, coalesce(c.kind, 'other') AS kind
    FROM parties p JOIN calls c ON c.id = p.id
    WHERE p.raw IS NOT NULL
  ),
  named AS (
    SELECT *, first_value(name) OVER (PARTITION BY relation, identifier ORDER BY name IS NULL, "startedAt" DESC) AS latest_name
    FROM identified
  ),
  kinds AS (
    SELECT relation, identifier_type, identifier, latest_name, kind,
      min("startedAt") AS first_at, max("startedAt") AS last_at, count(*) AS calls, total(duration) AS seconds
    FROM named GROUP BY relation, identifier_type, identifier, latest_name, kind
  )
  SELECT relation, identifier_type, identifier, NULL AS linked_type, NULL AS linked_identifier, max(latest_name) AS name,
    min(first_at) AS first_at, max(last_at) AS last_at, sum(calls) AS occurrences,
    json_object('kinds', json_group_object(kind, calls ORDER BY kind), 'seconds', CAST(round(sum(seconds)) AS INTEGER)) AS context
  FROM kinds GROUP BY relation, identifier_type, identifier`,
);
