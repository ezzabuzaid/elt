import { counterparts } from '@workspace/connector-apple-connector/counterparts';

export const calendarCounterparts = counterparts(
  "In Calendar, each event occurrence (events.eventId) is one record, so every occurrence of a recurring series counts. identifier is each participant of the event (attendees.url): an address after mailto: is trimmed and lowercase, an email when it holds an @, else app; any other URL is app as stored; a participant EventKit gives no address, whose URL is the stand-in invalid:nomail that many people share, is that URL and its name, such as invalid:nomail#Sam Rivera, as app, so it meets no identifier of another app (the URL alone when it has no name). relation is organizer for the event's organizer (attendees.kind organizer) and attendee for each attendee, the user's own addresses among them. self is each participant EventKit marks as the user (attendees.isCurrentUser), except on an event that also lists the same identifier without that mark: on an event that reaches the user through a distribution list, EventKit marks the organizer's own attendee entry as the user. Every event in the import counts, whatever its calendar and whoever declined: each is on a calendar this Mac shows the user, and an event that reached the user through a distribution list lists no participant as the user; context counts the statuses. Rooms, resources, groups and Google Calendar's own addresses stay, told apart by context. Calendar maps an identifier to no other, so linked_type and linked_identifier are NULL. name is the name EventKit gives on the latest of the events (attendees.name, by events.startAt), NULL when it gives none or only the address itself. Calendar reads a year ahead, where a recurring series repeats every occurrence, so occurrences, first_at, last_at and every context key but upcoming describe only the events that have begun when the view is read; an identifier on upcoming events alone has occurrences 0. first_at and last_at are the earliest and latest start (events.startAt) of the timed events among them; an all-day event has a date, not a time, so it counts in occurrences, firstDay and lastDay but not in first_at or last_at, which are NULL when every event is all-day. context keys: type, the participant type EventKit gives (attendees.type: person, room, resource, group, unknown, or other for a code EventKit does not document), the highest code when events differ, so a known type wins over unknown; googleCalendar, true for an address of Google Calendar itself (at calendar.google.com or a subdomain), which names a calendar, a room or resource, or Google's stand-in for an organizer it does not know (unknownorganizer@calendar.google.com), never a person's mailbox; status, how many events had each participant status (attendees.status: unknown, pending, accepted, declined, tentative, delegated, completed, inProcess, other), and role, each participant role (attendees.role: unknown, required, optional, chair, nonParticipant, other), with zero counts left out; for self, both come from the user's attendee entry when the user is also the organizer; smallest and largest, the number of participants (distinct identifiers, the organizer included) of the smallest and largest event, to tell a one-to-one from an all-hands; firstDay and lastDay, the local dates (events.startDate) of the earliest and latest all-day event, NULL when none; upcoming, how many events had not begun when the view was read.",
  `WITH participants AS (
    SELECT a."eventId", a.kind, a.status, a.role, a.type, a."isCurrentUser", a.url, trim(a.name) AS name,
      lower(trim(a.url)) GLOB 'mailto:*' AS mailto,
      CASE WHEN lower(trim(a.url)) GLOB 'mailto:*' THEN lower(trim(substr(trim(a.url), 8)))
        WHEN lower(trim(a.url)) NOT GLOB 'invalid:*' THEN a.url END AS address
    FROM attendees a
  ),
  identified AS (
    SELECT "eventId", kind, status, role, type, "isCurrentUser",
      CASE WHEN mailto AND address GLOB '*@*' THEN 'email' ELSE 'app' END AS identifier_type,
      coalesce(address, url || '#' || name, url) AS identifier,
      CASE WHEN lower(name) IS NOT address THEN name END AS name
    FROM participants
  ),
  marked AS (
    SELECT *, min("isCurrentUser") OVER (PARTITION BY "eventId", identifier_type, identifier) AS "alwaysUser"
    FROM identified
  ),
  sizes AS (
    SELECT "eventId", count(DISTINCT identifier_type || ':' || identifier) AS size FROM identified GROUP BY "eventId"
  ),
  relations AS (
    SELECT kind AS relation, * FROM marked
    UNION ALL
    SELECT 'self', * FROM marked WHERE "isCurrentUser" AND "alwaysUser"
  ),
  records AS (
    SELECT r.relation, r.identifier_type, r.identifier, r.status, r.role, r.type, s.size,
      e."startAt", e."allDay", e."startDate", e."startAt" <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS begun,
      first_value(r.name) OVER (PARTITION BY r.relation, r.identifier_type, r.identifier ORDER BY r.name IS NULL, e."startAt" DESC, r.name) AS name,
      row_number() OVER (PARTITION BY r.relation, r.identifier_type, r.identifier, r."eventId" ORDER BY r.kind = 'organizer') AS copy
    FROM relations r
    JOIN events e ON e."eventId" = r."eventId"
    JOIN sizes s ON s."eventId" = r."eventId"
  )
  SELECT relation, identifier_type, identifier, NULL AS linked_type, NULL AS linked_identifier, max(name) AS name,
    min(CASE WHEN begun AND NOT "allDay" THEN "startAt" END) AS first_at,
    max(CASE WHEN begun AND NOT "allDay" THEN "startAt" END) AS last_at,
    sum(begun) AS occurrences,
    json_object(
      'type', CASE max(type) WHEN 0 THEN 'unknown' WHEN 1 THEN 'person' WHEN 2 THEN 'room' WHEN 3 THEN 'resource' WHEN 4 THEN 'group' ELSE 'other' END,
      'googleCalendar', json(CASE WHEN identifier_type = 'email' AND (identifier GLOB '*@calendar.google.com' OR identifier GLOB '*@*.calendar.google.com') THEN 'true' ELSE 'false' END),
      'status', json_patch('{}', json_object(
        'unknown', nullif(sum(begun AND status = 0), 0),
        'pending', nullif(sum(begun AND status = 1), 0),
        'accepted', nullif(sum(begun AND status = 2), 0),
        'declined', nullif(sum(begun AND status = 3), 0),
        'tentative', nullif(sum(begun AND status = 4), 0),
        'delegated', nullif(sum(begun AND status = 5), 0),
        'completed', nullif(sum(begun AND status = 6), 0),
        'inProcess', nullif(sum(begun AND status = 7), 0),
        'other', nullif(sum(begun AND status NOT BETWEEN 0 AND 7), 0))),
      'role', json_patch('{}', json_object(
        'unknown', nullif(sum(begun AND role = 0), 0),
        'required', nullif(sum(begun AND role = 1), 0),
        'optional', nullif(sum(begun AND role = 2), 0),
        'chair', nullif(sum(begun AND role = 3), 0),
        'nonParticipant', nullif(sum(begun AND role = 4), 0),
        'other', nullif(sum(begun AND role NOT BETWEEN 0 AND 4), 0))),
      'smallest', min(CASE WHEN begun THEN size END),
      'largest', max(CASE WHEN begun THEN size END),
      'firstDay', min(CASE WHEN begun AND "allDay" THEN "startDate" END),
      'lastDay', max(CASE WHEN begun AND "allDay" THEN "startDate" END),
      'upcoming', sum(NOT begun)
    ) AS context
  FROM records
  WHERE copy = 1
  GROUP BY relation, identifier_type, identifier`,
);
