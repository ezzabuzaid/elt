import { eventKitScript } from '../eventkit-script.ts';

export const dateComponentNames = [
  'era',
  'year',
  'month',
  'day',
  'hour',
  'minute',
  'second',
  'nanosecond',
  'weekday',
  'weekdayOrdinal',
  'quarter',
  'weekOfMonth',
  'weekOfYear',
  'yearForWeekOfYear',
  'dayOfYear',
] as const;

export const remindersScript = `
${eventKitScript}

function fetchReminders(store) {
  let completed = false;
  let reminders;
  const predicate = store.predicateForRemindersInCalendars($());
  const request = store.fetchRemindersMatchingPredicateCompletion(predicate, result => {
    reminders = result;
    completed = true;
  });
  const deadline = Date.now() + 60000;
  while (!completed && Date.now() < deadline)
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.05));
  if (!completed) {
    store.cancelFetchRequest(request);
    throw new Error('EventKit reminder fetch timed out');
  }
  // A nil result means a failed fetch, not an empty collection to publish.
  if (eventKit.isNil(reminders)) throw new Error('EventKit reminder query failed');
  return eventKit.array(reminders);
}

function reminderDateComponents(reminderId, kind, components) {
  const { isNil, string, integer, bool } = eventKit;
  if (isNil(components)) return null;
  const values = {};
  for (const name of ${JSON.stringify(dateComponentNames)}) {
    // dayOfYear was introduced in macOS 15; preserve absence on macOS 14.
    const value = components.respondsToSelector(name) ? Number(components[name]) : Number($.NSDateComponentUndefined);
    values[name] = value === Number($.NSDateComponentUndefined) ? null : integer(value);
  }
  return {
    id: JSON.stringify([reminderId, kind]),
    reminderId,
    kind,
    calendarIdentifier: isNil(components.calendar) ? null : string(components.calendar.calendarIdentifier),
    timeZone: isNil(components.timeZone) ? null : string(components.timeZone.name),
    ...values,
    leapMonth: bool(components.isLeapMonth),
    repeatedDay: components.respondsToSelector('isRepeatedDay') ? bool(components.isRepeatedDay) : null,
  };
}

function readReminders(store, stream) {
  const { isNil, string, number, bool, timestamp, url } = eventKit;
  if (stream === 'accounts') return eventKit.accounts(store);
  if (stream === 'lists') return eventKit.calendars(store, 1);
  if (!['reminders', 'dateComponents', 'attendees', 'alarms', 'recurrenceRules', 'recurrenceRuleValues'].includes(stream))
    throw new Error('Unknown reminders stream: ' + stream);
  const records = [];
  for (const reminder of fetchReminders(store)) {
    const id = string(reminder.calendarItemIdentifier);
    const listId = isNil(reminder.calendar) ? null : string(reminder.calendar.calendarIdentifier);
    if (typeof id !== 'string' || !id || typeof listId !== 'string' || !listId)
      throw new Error('EventKit returned a reminder without a list or item identifier');
    if (stream === 'reminders') records.push({
      id,
      listId,
      externalId: string(reminder.calendarItemExternalIdentifier),
      name: string(reminder.title),
      body: string(reminder.notes),
      location: string(reminder.location),
      url: url(reminder.URL),
      timeZone: isNil(reminder.timeZone) ? null : string(reminder.timeZone.name),
      createdAt: timestamp(reminder.creationDate),
      modifiedAt: timestamp(reminder.lastModifiedDate),
      completed: bool(reminder.isCompleted),
      completedAt: timestamp(reminder.completionDate),
      priority: number(reminder.priority),
    });
    if (stream === 'dateComponents') {
      for (const kind of ['start', 'due']) {
        const row = reminderDateComponents(id, kind, reminder[kind + 'DateComponents']);
        if (row !== null) records.push(row);
      }
    }
    records.push(...eventKit.related(reminder, id, 'reminderId', stream));
  }
  return records;
}
`;
