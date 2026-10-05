import {
  type Properties,
  type RecordDraft,
  type SchemaRecord,
  Stream,
  type SyncMode,
  validateRecords,
} from '@workspace/elt';
import { eventKitFields } from '@workspace/source-apple-macos/eventkit-fields';

import type { CalendarScan } from './calendar-scan.ts';

const { id, location } = eventKitFields;

export const calendarFields = {
  ...eventKitFields,
  color: { type: ['number', 'null'], minimum: 0, maximum: 1 },
  eventId: {
    ...id,
    description:
      'Owning event occurrence; refers to events.eventId within this source.',
  },
  // ICS rows describe a whole native item, not one occurrence.
  icsItem: {
    calendarId: {
      ...id,
      description:
        'EventKit calendar identifier of the exported item; refers to calendars.id within this source.',
    },
    calendarItemId: {
      ...id,
      description:
        'EventKit EKCalendarItem.calendarItemIdentifier of the exported item. With calendarId it matches events of every occurrence of that item.',
    },
  },
} as const;

// An EKStructuredLocation, flattened; property names the EventKit property
// that holds it.
export function locationFields(property: string) {
  return {
    locationTitle: {
      ...location.locationTitle,
      description: `EventKit ${property}.title; NULL when there is no structured location or it has no title.`,
    },
    latitude: {
      ...location.latitude,
      description: `Latitude in degrees of EventKit ${property}.geoLocation; NULL when there is no structured location or it has no coordinate.`,
    },
    longitude: {
      ...location.longitude,
      description: `Longitude in degrees of EventKit ${property}.geoLocation; NULL when there is no structured location or it has no coordinate.`,
    },
    radius: {
      ...location.radius,
      description: `EventKit ${property}.radius in meters; 0 means EventKit's default radius. NULL when there is no structured location.`,
    },
  };
}

export const perOccurrence =
  'Rows belong to an occurrence, not a series: each selected occurrence of a recurring series repeats them, so counts across a series multiply.';

// What the source needs from any Calendar stream, whatever its record type.
export type CalendarReader = {
  readonly name: string;
  readonly requiresIcs: boolean;
  readonly dated: boolean;
  describe(): Stream;
  read(scan: CalendarScan): Promise<Record<string, unknown>[]>;
  file(
    record: Record<string, unknown>,
    scan: CalendarScan,
    staging: string,
  ): Promise<string | null>;
};

// A Calendar stream: its description, and how its records come out of a run's
// scan. Reading is the same for every stream — pick the rows, project each,
// validate against the schema — so streams supply only those two steps.
export abstract class CalendarStream<P extends Properties, Row> {
  abstract readonly name: string;
  abstract readonly jsonSchema: {
    readonly type: 'object';
    readonly description: string;
    readonly properties: P;
    readonly required: string[];
  };
  readonly primaryKey: readonly string[] = ['id'];
  readonly supportedSyncModes: readonly SyncMode[] = Object.freeze([
    'full_refresh',
    'incremental',
  ]);
  // Every read is the whole window, so incremental copies diff snapshots.
  readonly sourceDefinedCursor = true;
  readonly emitsDeletes = true;
  // Whether a read must ask EventKit for the private ICS export.
  readonly requiresIcs: boolean = false;
  // Whether the event window limits the stream; the account and calendar
  // listings it does not.
  readonly dated: boolean = true;
  #stream?: Stream;

  describe(): Stream {
    this.#stream ??= new Stream(this);
    return this.#stream;
  }

  async read(scan: CalendarScan): Promise<SchemaRecord<P>[]> {
    return validateRecords(
      this,
      this.rows(scan).map((row) => this.record(row, scan)),
      'EventKit',
    );
  }

  // The file a record carries, for streams that support file reads, staged
  // under staging.
  async file(
    _record: SchemaRecord<P>,
    _scan: CalendarScan,
    _staging: string,
  ): Promise<string | null> {
    return null;
  }

  protected abstract rows(scan: CalendarScan): readonly Row[];

  protected abstract record(row: Row, scan: CalendarScan): RecordDraft<P>;
}
