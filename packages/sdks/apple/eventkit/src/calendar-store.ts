import type {
  EventKitDocument,
  IcsDocument,
  OccurrenceDocument,
} from './documents.ts';
import {
  CalendarUnavailableError,
  IcsExportUnavailableError,
} from './errors.ts';
import {
  type Collections,
  type EventKitQuery,
  EventKitStore,
  helperStderr,
} from './eventkit-store.ts';

export type CalendarQuery = EventKitQuery & {
  // The UTC interval [startAt, endAt), as canonical ISO timestamps; a
  // zero-duration event must start inside it, others must overlap it.
  readonly startAt: string;
  readonly endAt: string;
  // Also export each item's iCalendar data, through private EventKit API.
  readonly ics: boolean;
};

export type CalendarContents = Collections & {
  readonly occurrences: readonly OccurrenceDocument[];
  readonly icsExports: readonly IcsDocument[];
};

// Event calendars and the event occurrences inside an interval.
export class CalendarStore extends EventKitStore<
  CalendarQuery,
  CalendarContents
> {
  protected readonly entity = 'events';
  protected readonly accessMarker = 'CALENDAR_UNAVAILABLE';

  protected request({ startAt, endAt, ics }: CalendarQuery) {
    return { startAt, endAt, ics };
  }

  protected contents(
    collections: Collections,
    documents: readonly EventKitDocument[],
  ): CalendarContents {
    return {
      ...collections,
      occurrences: documents.filter(
        (document) => document.type === 'occurrence',
      ),
      icsExports: documents.filter((document) => document.type === 'ics'),
    };
  }

  protected accessDenied(cause: unknown): Error {
    return new CalendarUnavailableError(cause);
  }

  protected override failure(error: unknown): unknown {
    return helperStderr(error).includes('CALENDAR_ICS_UNAVAILABLE')
      ? new IcsExportUnavailableError(error)
      : super.failure(error);
  }
}
