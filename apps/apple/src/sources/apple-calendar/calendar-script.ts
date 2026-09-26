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
  const ics = ['icsComponents', 'icsProperties', 'icsParameters', 'icsAttachments'].includes(stream);
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
  const selected = array(events).filter((event) => {
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
  if (ics) {
    const items = new Map();
    for (const event of selected) {
      const calendarId = string(event.calendar.calendarIdentifier);
      const calendarItemId = string(event.calendarItemIdentifier);
      if (!calendarId || !calendarItemId)
        throw new Error('EventKit event has no calendar or item identifier');
      items.set(JSON.stringify([calendarId, calendarItemId]), event);
    }
    const keys = Array.from(items.keys()).sort().filter((key) => after === null || key > after);
    // Bound each ICS response by item count, independent of date density.
    const page = keys.slice(0, 100);
    return {
      records: page.map((key) => exportICS(items.get(key))),
      nextCursor: keys.length > page.length ? page[page.length - 1] : null,
    };
  }

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

    records.push(...eventKit.related(event, eventId, 'eventId', stream));
  }
  return records;
}
`;
