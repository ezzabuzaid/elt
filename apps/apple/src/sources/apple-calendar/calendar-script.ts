import { eventKitScript } from '../eventkit-script.ts';

export const calendarScript = `
${eventKitScript}

function readCalendar(
  store,
  stream,
  startAt,
  endAt,
  calendarApplication,
  after = null,
) {
  const names = [
    'accounts',
    'calendars',
    'events',
    'eventMetadata',
    'excludedDates',
    'attendees',
    'alarms',
    'recurrenceRules',
    'recurrenceRuleValues',
    'icsComponents',
    'icsProperties',
    'icsParameters',
    'icsAttachments',
  ];
  if (!names.includes(stream)) throw new Error('Unknown calendar stream: ' + stream);
  const wants = (name) => stream === name;
  const scripting = wants('eventMetadata') || wants('excludedDates');
  const ics = ['icsComponents', 'icsProperties', 'icsParameters', 'icsAttachments'].includes(stream);
  // Per-item streams page by native item; only metadata needs Calendar scripting.
  const paged = scripting || ics;
  const records = [];
  const emit = (name, row) => {
    if (wants(name)) records.push(row);
  };
  const { isNil, array, string, number, bool, nativeDate, milliseconds, timestamp, dateOnly, url, location } = eventKit;
  const scriptingCalendars = new Map();
  const scriptingCalendar = (calendarId, name) => {
    const key = JSON.stringify([calendarId, name]);
    if (scriptingCalendars.has(key)) return scriptingCalendars.get(key);
    const calendar = (calendarApplication ?? Application('Calendar')).calendars.byId(
      calendarId,
    );
    // Calendar returns a synthetic empty object for unknown IDs. This verifies
    // EventKit's native identifier; it does not look up by name.
    if (calendar.name() !== name)
      throw new Error('Calendar scripting lookup did not match EventKit calendar ' + calendarId);
    scriptingCalendars.set(key, calendar);
    return calendar;
  };
  const scriptingTimestamp = (value) => {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
      throw new Error('Calendar scripting returned an invalid date');
    return value.toISOString();
  };
  // The ICS export is private EventKit API: detect it, and fail rather than
  // return nothing when it is missing or produces no data.
  const exportICS = (event) => {
    const calendarId = string(event.calendar.calendarIdentifier);
    const calendarItemId = string(event.calendarItemIdentifier);
    const stored = store.calendarItemWithIdentifier(calendarItemId);
    if (isNil(stored))
      throw new Error('EventKit could not resolve the calendar item for ICS export');
    const responds = (selector) =>
      typeof store.respondsToSelector === 'function' && store.respondsToSelector(selector);
    let data;
    if (responds('ICSDataForCalendarItems:preventLineFolding:'))
      data = store.ICSDataForCalendarItemsPreventLineFolding($([stored]), true);
    else if (responds('ICSDataForCalendarItems:options:'))
      data = store.ICSDataForCalendarItemsOptions($([stored]), 0);
    else
      throw new Error('CALENDAR_ICS_UNAVAILABLE: EKEventStore has no ICS export on this macOS version');
    if (isNil(data) || Number(data.length) === 0)
      throw new Error('EventKit ICS export returned no data for ' + calendarItemId);
    return {
      calendarId,
      calendarItemId,
      recurring: array(event.recurrenceRules).length > 0 || bool(event.isDetached),
      ics: ObjC.unwrap(data.base64EncodedStringWithOptions(0)),
    };
  };
  const scriptingMetadata = (calendarId, calendarName, calendarItemId) => {
    const calendar = scriptingCalendar(calendarId, calendarName);
    // Read all scripting fields in one Apple Event per native item.
    const scriptingEvent = calendar.events.byId(calendarItemId).properties();
    const scriptingUid = scriptingEvent.uid;
    if (typeof scriptingUid !== 'string' || !scriptingUid)
      throw new Error('Calendar scripting returned an invalid event UID');
    const stored = store.calendarItemWithIdentifier(calendarItemId);
    if (
      isNil(stored) ||
      string(stored.calendarItemIdentifier) !== calendarItemId ||
      string(stored.calendar.calendarIdentifier) !== calendarId
    )
      throw new Error('EventKit could not resolve the calendar item for scripting');
    const detached = bool(stored.isDetached);
    if (!detached && scriptingUid !== calendarItemId)
      throw new Error('Calendar scripting event UID did not match EventKit item');
    const startAt = timestamp(stored.startDate);
    const endAt = timestamp(stored.endDate);
    if (
      startAt === null ||
      endAt === null ||
      scriptingTimestamp(scriptingEvent.startDate) !== startAt ||
      scriptingTimestamp(scriptingEvent.endDate) !== endAt
    )
      throw new Error('Calendar scripting event did not match EventKit dates');
    const resolved = store.calendarItemWithIdentifier(scriptingUid);
    if (
      isNil(resolved) ||
      string(resolved.calendar.calendarIdentifier) !== calendarId ||
      string(resolved.calendarItemIdentifier) !== scriptingUid ||
      (!detached &&
        !isNil(stored.calendarItemExternalIdentifier) &&
        string(resolved.calendarItemExternalIdentifier) !==
          string(stored.calendarItemExternalIdentifier))
    )
      throw new Error('Calendar scripting event did not resolve to the EventKit calendar item');
    const rawRecurrence = scriptingEvent.recurrence;
    if (rawRecurrence !== null && typeof rawRecurrence !== 'string')
      throw new Error('Calendar scripting returned an invalid recurrence');
    const sequence = scriptingEvent.sequence;
    if (!Number.isSafeInteger(sequence))
      throw new Error('Calendar scripting returned an invalid event sequence');
    const excluded = scriptingEvent.excludedDates;
    if (!Array.isArray(excluded))
      throw new Error('Calendar scripting returned invalid excluded dates');
    return { scriptingUid, rawRecurrence, sequence, excluded };
  };
  if (wants('accounts')) return eventKit.accounts(store);
  if (wants('calendars'))
    return eventKit.calendars(store, 0).map((calendar) => ({
      ...calendar,
      description: scriptingCalendar(calendar.id, calendar.name).description(),
    }));
  const calendars = store.calendarsForEntityType(0);
  if (isNil(calendars)) throw new Error('EventKit returned no event calendars');

  const eventStreams = [
    'events',
    'eventMetadata',
    'excludedDates',
    'attendees',
    'alarms',
    'recurrenceRules',
    'recurrenceRuleValues',
    'icsComponents',
    'icsProperties',
    'icsParameters',
    'icsAttachments',
  ];
  if (!eventStreams.includes(stream)) return records;

  const rangeStart = nativeDate(startAt);
  const rangeEnd = nativeDate(endAt);
  const rangeStartMs = milliseconds(rangeStart);
  const rangeEndMs = milliseconds(rangeEnd);
  if (
    rangeStartMs === null ||
    rangeEndMs === null ||
    rangeEndMs <= rangeStartMs ||
    rangeEndMs - rangeStartMs > 366 * 24 * 60 * 60 * 1000
  )
    throw new Error('Calendar range must be positive and no longer than 366 days');

  const predicate = store.predicateForEventsWithStartDateEndDateCalendars(
    rangeStart,
    rangeEnd,
    calendars,
  );
  const events = store.eventsMatchingPredicate(predicate);
  if (isNil(events)) throw new Error('EventKit event query failed');
  let selected = array(events).filter((event) => {
    const startMs = milliseconds(event.startDate);
    const endMs = milliseconds(event.endDate);
    if (startMs === null || endMs === null)
      throw new Error('EventKit returned an event without valid dates');
    const overlaps =
      startMs === endMs
        ? startMs >= rangeStartMs && startMs < rangeEndMs
        : startMs < rangeEndMs && endMs > rangeStartMs;
    return overlaps;
  });
  let nextCursor = null;
  if (paged) {
    const items = new Map();
    for (const event of selected) {
      const calendarId = string(event.calendar.calendarIdentifier);
      const calendarItemId = string(event.calendarItemIdentifier);
      if (!calendarId || !calendarItemId)
        throw new Error('EventKit event has no calendar or item identifier');
      items.set(JSON.stringify([calendarId, calendarItemId]), event);
    }
    const keys = Array.from(items.keys()).sort().filter((key) => after === null || key > after);
    // Bound expensive Calendar Apple Events by item count, independent of date density.
    const page = keys.slice(0, 100);
    if (keys.length > page.length) nextCursor = page[page.length - 1];
    selected = page.map((key) => items.get(key));
  }
  if (ics) return { records: selected.map(exportICS), nextCursor };

  for (const event of selected) {

    const allDay = bool(event.isAllDay);
    const rules = array(event.recurrenceRules);
    const recurring = rules.length > 0 || bool(event.isDetached);
    const occurrence = recurring ? event.occurrenceDate : null;
    if (recurring && isNil(occurrence))
      throw new Error('EventKit returned a recurring event without an occurrence date');
    const occurrenceKey =
      !recurring
        ? null
        : allDay
          ? dateOnly(occurrence)
          : timestamp(occurrence);
    const calendarId = string(event.calendar.calendarIdentifier);
    const calendarItemId = string(event.calendarItemIdentifier);
    if (typeof calendarId !== 'string' || !calendarId || typeof calendarItemId !== 'string' || !calendarItemId)
      throw new Error('EventKit event has no calendar or item identifier');
    const eventId = JSON.stringify([calendarId, calendarItemId, occurrenceKey]);
    const eventLocation = location(event.structuredLocation);
    const calendarName = string(event.calendar.title);
    if (typeof calendarName !== 'string')
      throw new Error('EventKit event calendar has no valid name');

    if (wants('events'))
      emit('events', {
        id: eventId,
        eventId,
        calendarId,
        calendarItemId,
        externalId: string(event.calendarItemExternalIdentifier),
        nativeEventId: string(event.eventIdentifier),
        name: string(event.title),
        body: string(event.notes),
        location: string(event.location),
        url: url(event.URL),
        startAt: timestamp(event.startDate),
        endAt: timestamp(event.endDate),
        allDay,
        startDate: allDay ? dateOnly(event.startDate) : null,
        endDate: allDay ? dateOnly(event.endDate) : null,
        timeZone: isNil(event.timeZone) ? null : string(event.timeZone.name),
        createdAt: timestamp(event.creationDate),
        modifiedAt: timestamp(event.lastModifiedDate),
        occurrenceAt: recurring ? timestamp(occurrence) : null,
        occurrenceDate: allDay && recurring ? dateOnly(occurrence) : null,
        detached: bool(event.isDetached),
        status: number(event.status),
        availability: number(event.availability),
        birthdayContactId: string(event.birthdayContactIdentifier),
        locationTitle: eventLocation.title,
        latitude: eventLocation.latitude,
        longitude: eventLocation.longitude,
        radius: eventLocation.radius,
      });

    if (scripting) {
      const id = JSON.stringify([calendarId, calendarItemId]);
      const metadata = scriptingMetadata(
        calendarId,
        calendarName,
        calendarItemId,
      );
      if (wants('eventMetadata'))
        emit('eventMetadata', {
          id,
          calendarId,
          calendarItemId,
          scriptingUid: metadata.scriptingUid,
          rawRecurrence: metadata.rawRecurrence,
          sequence: metadata.sequence,
        });
      if (wants('excludedDates'))
        for (const [position, excluded] of metadata.excluded.entries()) {
          const excludedAt = scriptingTimestamp(excluded);
          emit('excludedDates', {
            id: JSON.stringify([id, position]),
            eventMetadataId: id,
            position,
            excludedAt,
            excludedDate: allDay
              ? dateOnly($.NSDate.dateWithTimeIntervalSince1970(Date.parse(excludedAt) / 1000))
              : null,
          });
        }
    }

    records.push(...eventKit.related(event, eventId, 'eventId', stream));
  }
  return scripting ? { records, nextCursor } : records;
}
`;
