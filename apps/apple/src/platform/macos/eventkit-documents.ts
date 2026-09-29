// What the eventkit helper writes, one document per line. Dates are epoch
// milliseconds; `…Day` fields are local yyyy-MM-dd dates. A field the helper
// leaves out is null.

export type AccountDocument = {
  readonly type: 'account';
  readonly id: string;
  readonly name: string;
  readonly sourceType: number;
  readonly isDelegate: boolean;
};

export type CalendarDocument = {
  readonly type: 'calendar';
  readonly id: string;
  readonly accountId?: string;
  readonly name: string;
  readonly calendarType: number;
  readonly writable: boolean;
  readonly subscribed: boolean;
  readonly immutable: boolean;
  readonly color?: readonly [number, number, number, number];
  readonly supportedAvailabilities: number;
  readonly allowedEntityTypes: number;
  // Calendar.app's description of an event calendar.
  readonly notes?: string;
  // Inside the request's account and collection scope.
  readonly selected: boolean;
};

export type LocationDocument = {
  readonly title?: string;
  readonly latitude?: number;
  readonly longitude?: number;
  readonly radius: number;
};

export type ParticipantDocument = {
  readonly name?: string;
  readonly url: string;
  readonly status: number;
  readonly role: number;
  readonly participantType: number;
  readonly isCurrentUser: boolean;
};

export type AlarmDocument = {
  readonly alarmType: number;
  readonly relativeOffset: number;
  readonly absoluteMs?: number;
  readonly emailAddress?: string;
  readonly soundName?: string;
  readonly proximity: number;
  readonly location?: LocationDocument;
};

export type RecurrenceRuleDocument = {
  readonly calendarIdentifier?: string;
  readonly frequency: number;
  readonly interval: number;
  readonly firstDayOfWeek: number;
  readonly end?: { readonly endMs?: number; readonly occurrenceCount: number };
  readonly daysOfTheWeek: readonly {
    readonly day: number;
    readonly weekNumber: number;
  }[];
  readonly daysOfTheMonth: readonly number[];
  readonly daysOfTheYear: readonly number[];
  readonly weeksOfTheYear: readonly number[];
  readonly monthsOfTheYear: readonly number[];
  readonly setPositions: readonly number[];
};

// Parts every calendar item carries, event or reminder.
export type CalendarItemDocument = {
  readonly attendees: readonly ParticipantDocument[];
  readonly alarms: readonly AlarmDocument[];
  readonly recurrenceRules: readonly RecurrenceRuleDocument[];
};

export type OccurrenceDocument = CalendarItemDocument & {
  readonly type: 'occurrence';
  readonly calendarId: string;
  readonly calendarItemId: string;
  readonly externalId?: string;
  readonly nativeEventId?: string;
  readonly name?: string;
  readonly body?: string;
  readonly location?: string;
  readonly url?: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly startDay: string;
  readonly endDay: string;
  readonly allDay: boolean;
  readonly timeZone?: string;
  readonly createdMs?: number;
  readonly modifiedMs?: number;
  readonly occurrenceMs?: number;
  readonly occurrenceDay?: string;
  readonly detached: boolean;
  readonly status: number;
  readonly availability: number;
  readonly birthdayContactId?: string;
  readonly place?: LocationDocument;
  readonly organizer?: ParticipantDocument;
};

export type IcsDocument = {
  readonly type: 'ics';
  readonly calendarId: string;
  readonly calendarItemId: string;
  readonly recurring: boolean;
  // Base64 iCalendar export of the native item, series included.
  readonly ics: string;
};

export type DateComponentsDocument = {
  readonly calendarIdentifier?: string;
  readonly timeZone?: string;
  readonly era?: number;
  readonly year?: number;
  readonly month?: number;
  readonly day?: number;
  readonly hour?: number;
  readonly minute?: number;
  readonly second?: number;
  readonly nanosecond?: number;
  readonly weekday?: number;
  readonly weekdayOrdinal?: number;
  readonly quarter?: number;
  readonly weekOfMonth?: number;
  readonly weekOfYear?: number;
  readonly yearForWeekOfYear?: number;
  readonly dayOfYear?: number;
  readonly leapMonth: boolean;
  readonly repeatedDay?: boolean;
};

export type ReminderDocument = CalendarItemDocument & {
  readonly type: 'reminder';
  readonly id: string;
  readonly listId: string;
  readonly externalId?: string;
  readonly name?: string;
  readonly body?: string;
  readonly location?: string;
  readonly url?: string;
  readonly timeZone?: string;
  readonly createdMs?: number;
  readonly modifiedMs?: number;
  readonly completed: boolean;
  readonly completedMs?: number;
  readonly priority: number;
  readonly start?: DateComponentsDocument;
  readonly due?: DateComponentsDocument;
};

export type EventKitDocument =
  | AccountDocument
  | CalendarDocument
  | OccurrenceDocument
  | IcsDocument
  | ReminderDocument;
