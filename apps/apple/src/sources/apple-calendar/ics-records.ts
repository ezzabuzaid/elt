import { type ICalComponent, parseICalendar } from './icalendar.ts';

export const icsStreams = [
  'icsComponents',
  'icsProperties',
  'icsParameters',
] as const;
export type IcsStream = (typeof icsStreams)[number];

export type IcsExport = {
  readonly calendarId: string;
  readonly calendarItemId: string;
  readonly recurring: boolean;
  readonly ics: string;
};

export function isIcsStream(name: string): name is IcsStream {
  return (icsStreams as readonly string[]).includes(name);
}

export function validateIcsExports(items: unknown): IcsExport[] {
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

// One native item's export as scalar rows: the component tree, its properties
// with raw values, and one row per parameter value. RECURRENCE-ID stays raw with
// its TZID; eventId is set only where it is exact (a non-recurring master).
// DTSTAMP is omitted: EventKit stamps it with the export time, so it is not
// stored event data and would change every row on every incremental run.
export function icsRecords(
  stream: IcsStream,
  item: IcsExport,
): Record<string, unknown>[] {
  const { calendarId, calendarItemId } = item;
  const calendar = parseICalendar(Buffer.from(item.ics, 'base64'));
  if (!calendar.components.some((component) => component.name === 'VEVENT'))
    throw new TypeError(
      `EventKit ICS export returned no VEVENT for saved item ${calendarItemId}`,
    );
  const rows: Record<IcsStream, Record<string, unknown>[]> = {
    icsComponents: [],
    icsProperties: [],
    icsParameters: [],
  };
  const walk = (
    component: ICalComponent,
    path: string,
    parentId: string | null,
    position: number,
  ) => {
    const id = JSON.stringify([calendarId, calendarItemId, path]);
    const property = (name: string) =>
      component.properties.find((candidate) => candidate.name === name);
    const recurrence = property('RECURRENCE-ID');
    rows.icsComponents.push({
      id,
      eventMetadataId: JSON.stringify([calendarId, calendarItemId]),
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
    });
    const properties = component.properties.filter(
      (property) => property.name !== 'DTSTAMP',
    );
    for (const [index, { name, value, parameters }] of properties.entries()) {
      const propertyKey = [calendarId, calendarItemId, path, index];
      const propertyId = JSON.stringify(propertyKey);
      rows.icsProperties.push({
        id: propertyId,
        componentId: id,
        calendarId,
        calendarItemId,
        position: index,
        name,
        value,
      });
      for (const [parameterIndex, parameter] of parameters.entries())
        for (const [valueIndex, parameterValue] of parameter.values.entries())
          rows.icsParameters.push({
            id: JSON.stringify([...propertyKey, parameterIndex, valueIndex]),
            propertyId,
            componentId: id,
            calendarId,
            calendarItemId,
            position: parameterIndex,
            valuePosition: valueIndex,
            name: parameter.name,
            value: parameterValue,
          });
    }
    for (const [index, child] of component.components.entries())
      walk(child, `${path}.${index}`, id, index);
  };
  walk(calendar, '0', null, 0);
  return rows[stream];
}
