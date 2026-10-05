import type {
  AccountDocument,
  CalendarContents,
  CalendarDocument,
  LocationDocument,
  OccurrenceDocument,
  RecurrenceRuleDocument,
} from '@workspace/macos-eventkit';

import type {
  CalendarAttachment,
  CalendarAttachmentFetcher,
} from './apple-calendar-source.ts';
import {
  type ICalComponent,
  type ICalProperty,
  parseICalendar,
} from './icalendar.ts';

// One occurrence with the identity every event row and related row uses.
export type CalendarEvent = {
  readonly eventId: string;
  // An event recurs when it has recurrence rules or is detached.
  readonly recurring: boolean;
  readonly occurrence: OccurrenceDocument;
};

// One recurrence rule of an occurrence, with the id its list values join on.
export type CalendarRule = {
  readonly eventId: string;
  readonly ruleId: string;
  readonly position: number;
  readonly rule: RecurrenceRuleDocument;
};

// The native item an ICS export describes, whole.
export type IcsItem = {
  readonly calendarId: string;
  readonly calendarItemId: string;
  readonly recurring: boolean;
};

export type IcsComponentNode = {
  readonly item: IcsItem;
  readonly id: string;
  readonly parentId: string | null;
  readonly position: number;
  readonly component: ICalComponent;
};

export type IcsPropertyNode = {
  readonly item: IcsItem;
  readonly componentId: string;
  // [calendarId, calendarItemId, path, position]; parameter ids extend it.
  readonly key: readonly (string | number)[];
  readonly id: string;
  readonly position: number;
  readonly property: ICalProperty;
};

export type IcsTree = {
  readonly components: readonly IcsComponentNode[];
  readonly properties: readonly IcsPropertyNode[];
};

export function timestamp(ms: number | undefined): string | null {
  return ms === undefined ? null : new Date(ms).toISOString();
}

export function location(place: LocationDocument | undefined) {
  return {
    locationTitle: place?.title ?? null,
    latitude: place?.latitude ?? null,
    longitude: place?.longitude ?? null,
    radius: place?.radius ?? null,
  };
}

// One run's EventKit read, shared by every Calendar stream: the work several
// streams need — the occurrences' identities, the parsed ICS exports — is done
// once, when the first stream asks for it.
export class CalendarScan implements AsyncDisposable {
  readonly #contents: CalendarContents;
  readonly #attachments?: CalendarAttachmentFetcher;
  #events?: readonly CalendarEvent[];
  #rules?: readonly CalendarRule[];
  #ics?: IcsTree;

  constructor(
    contents: CalendarContents,
    attachments: CalendarAttachmentFetcher | undefined,
  ) {
    this.#contents = contents;
    this.#attachments = attachments;
  }

  get accounts(): readonly AccountDocument[] {
    return this.#contents.accounts;
  }

  get calendars(): readonly CalendarDocument[] {
    return this.#contents.calendars;
  }

  // The store lists an occurrence once for each read window it spans; its
  // first copy is kept.
  get events(): readonly CalendarEvent[] {
    if (this.#events === undefined) {
      const events = new Map<string, CalendarEvent>();
      for (const occurrence of this.#contents.occurrences) {
        const event = identify(occurrence);
        if (!events.has(event.eventId)) events.set(event.eventId, event);
      }
      this.#events = [...events.values()];
    }
    return this.#events;
  }

  get rules(): readonly CalendarRule[] {
    this.#rules ??= this.events.flatMap(({ eventId, occurrence }) =>
      occurrence.recurrenceRules.map((rule, position) => ({
        eventId,
        ruleId: JSON.stringify([eventId, 'recurrenceRule', position]),
        position,
        rule,
      })),
    );
    return this.#rules;
  }

  get ics(): IcsTree {
    this.#ics ??= walk(validateIcsExports(this.#contents.icsExports));
    return this.#ics;
  }

  // Writes an attachment's bytes to path through the fetcher the app supplied.
  async fetch(attachment: CalendarAttachment, path: string): Promise<boolean> {
    if (this.#attachments === undefined)
      throw new TypeError(
        'Reading Calendar attachment files requires an attachments fetcher: new AppleCalendarSource({ ..., attachments })',
      );
    return this.#attachments(attachment, path);
  }

  async [Symbol.asyncDispose](): Promise<void> {}
}

// An occurrence's id: its item plus, for a recurring event, the occurrence it
// replaces (a local date when all-day), so rescheduling keeps the id.
function identify(occurrence: OccurrenceDocument): CalendarEvent {
  const recurring =
    occurrence.recurrenceRules.length > 0 || occurrence.detached;
  if (recurring && occurrence.occurrenceMs === undefined)
    throw new TypeError(
      'EventKit returned a recurring event without an occurrence date',
    );
  let occurrenceKey: string | null = null;
  if (recurring)
    occurrenceKey = occurrence.allDay
      ? (occurrence.occurrenceDay ?? null)
      : timestamp(occurrence.occurrenceMs);
  const eventId = JSON.stringify([
    occurrence.calendarId,
    occurrence.calendarItemId,
    occurrenceKey,
  ]);
  return { eventId, recurring, occurrence };
}

type IcsExport = IcsItem & { readonly ics: string };

function validateIcsExports(items: unknown): IcsExport[] {
  if (
    !Array.isArray(items) ||
    !items.every(
      (item) =>
        item !== null &&
        typeof item === 'object' &&
        typeof item.calendarId === 'string' &&
        typeof item.calendarItemId === 'string' &&
        typeof item.recurring === 'boolean' &&
        typeof item.ics === 'string',
    )
  )
    throw new TypeError('EventKit returned an invalid ICS export page');
  return items;
}

// Each native item's export as a tree of components with their property
// lines. DTSTAMP is omitted: EventKit stamps it with the export time, so it is
// not stored event data and would change every row on every incremental run.
function walk(exports: readonly IcsExport[]): IcsTree {
  const components: IcsComponentNode[] = [];
  const properties: IcsPropertyNode[] = [];
  for (const { ics, ...item } of exports) {
    const { calendarId, calendarItemId } = item;
    const calendar = parseICalendar(Buffer.from(ics, 'base64'));
    if (!calendar.components.some((component) => component.name === 'VEVENT'))
      throw new TypeError(
        `EventKit ICS export returned no VEVENT for saved item ${calendarItemId}`,
      );
    const visit = (
      component: ICalComponent,
      path: string,
      parentId: string | null,
      position: number,
    ) => {
      const id = JSON.stringify([calendarId, calendarItemId, path]);
      components.push({ item, id, parentId, position, component });
      const lines = component.properties.filter(
        (property) => property.name !== 'DTSTAMP',
      );
      for (const [index, property] of lines.entries()) {
        const key = [calendarId, calendarItemId, path, index];
        properties.push({
          item,
          componentId: id,
          key,
          id: JSON.stringify(key),
          position: index,
          property,
        });
      }
      for (const [index, child] of component.components.entries())
        visit(child, `${path}.${index}`, id, index);
    };
    visit(inContentOrder(calendar), '0', null, 0);
  }
  return { components, properties };
}

// Plain code-unit order, not locale order, so the numbering is the same on
// every machine.
function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// EventKit's export lists sibling components (a series' exceptions, their
// alarms) in a different order in each process (verified live), so they are
// numbered in content order: an unchanged item exports identical rows.
// Properties and parameters keep their export order, which is stable.
function inContentOrder(component: ICalComponent): ICalComponent {
  const components = component.components
    .map(inContentOrder)
    .map((child) => [JSON.stringify(child), child] as const)
    .sort(([a], [b]) => compareCodeUnits(a, b))
    .map(([, child]) => child);
  return { ...component, components };
}
