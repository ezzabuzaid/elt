import type { RecordDraft } from '@workspace/elt';

import type { CalendarScan, IcsComponentNode } from '../calendar-scan.ts';
import { CalendarStream, calendarFields } from '../calendar-stream.ts';

const { id, icsItem, nullableText, ordinal, text } = calendarFields;

const properties = {
  id: {
    ...id,
    description:
      'JSON [calendarId, calendarItemId, path], where path lists child positions from the root VCALENDAR ("0", "0.1", …).',
  },
  ...icsItem,
  parentId: {
    ...nullableText,
    description:
      'Enclosing component; refers to icsComponents.id within this source. NULL for the root VCALENDAR.',
  },
  position: {
    ...ordinal,
    description:
      "Order among sibling components, numbered in content order: EventKit's export order changes between reads.",
  },
  name: {
    ...text,
    description:
      'Component name as exported, uppercased, such as VCALENDAR, VEVENT or VALARM.',
  },
  uid: {
    ...nullableText,
    description:
      "Raw value of the component's UID property; NULL when it has none.",
  },
  recurrenceId: {
    ...nullableText,
    description:
      "Raw, unparsed value of the component's RECURRENCE-ID property, which marks a component overriding one occurrence of a series; NULL when absent.",
  },
  recurrenceIdTimeZone: {
    ...nullableText,
    description:
      'First TZID parameter value of RECURRENCE-ID; NULL when RECURRENCE-ID is absent or has no TZID.',
  },
  eventId: {
    ...nullableText,
    description:
      'events.eventId of the nonrecurring event this VEVENT exactly describes: set only for a VEVENT without RECURRENCE-ID of an item that has no recurrence rules and is not detached. NULL for every other component, including all components of a recurring item, which relate at (calendarId, calendarItemId).',
  },
} as const;

export class IcsComponentsStream extends CalendarStream<
  typeof properties,
  IcsComponentNode
> {
  readonly name = 'icsComponents';
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per iCalendar component in the private EventKit ICS export of each native item with an occurrence in the event window: the VCALENDAR root, the VEVENT master, exception VEVENTs carrying RECURRENCE-ID, their alarms and any other exported component. Each item is exported once and whole, so a recurring series can describe occurrences outside the window. Grain is the native item (calendarId, calendarItemId), not an occurrence: eventId is set only for a nonrecurring VEVENT. Joining recurring components to events on (calendarId, calendarItemId) repeats them once per occurrence, so aggregate occurrences before joining. The ICS streams are read only when one is selected; on a macOS without the private export the read fails instead of loading no rows. Relationships name source streams, not destination tables.',
    properties,
    required: Object.keys(properties),
  } as const;
  override readonly requiresIcs = true;

  protected rows(scan: CalendarScan): readonly IcsComponentNode[] {
    return scan.ics.components;
  }

  // RECURRENCE-ID stays raw with its TZID; eventId is set only where it is
  // exact: a non-recurring master.
  protected record({
    item,
    id,
    parentId,
    position,
    component,
  }: IcsComponentNode): RecordDraft<typeof properties> {
    const { calendarId, calendarItemId } = item;
    const property = (name: string) =>
      component.properties.find((candidate) => candidate.name === name);
    const recurrence = property('RECURRENCE-ID');
    return {
      id,
      calendarId,
      calendarItemId,
      parentId,
      position,
      name: component.name,
      uid: property('UID')?.value ?? null,
      recurrenceId: recurrence?.value ?? null,
      recurrenceIdTimeZone:
        recurrence?.parameters.find((parameter) => parameter.name === 'TZID')
          ?.values[0] ?? null,
      eventId:
        component.name === 'VEVENT' && !item.recurring && !recurrence
          ? JSON.stringify([calendarId, calendarItemId, null])
          : null,
    };
  }
}
