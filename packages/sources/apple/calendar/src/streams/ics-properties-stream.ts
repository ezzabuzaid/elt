import type { RecordDraft } from '@workspace/elt';

import type { CalendarScan, IcsPropertyNode } from '../calendar-scan.ts';
import { CalendarStream, calendarFields } from '../calendar-stream.ts';

const { id, icsItem, ordinal, text } = calendarFields;

const properties = {
  id: {
    ...id,
    description:
      'JSON [calendarId, calendarItemId, path, position], extending the component path; icsParameters.propertyId and icsAttachments.propertyId refer to it.',
  },
  componentId: {
    ...id,
    description:
      'Owning component; refers to icsComponents.id within this source.',
  },
  ...icsItem,
  position: {
    ...ordinal,
    description:
      "Index among the component's properties in export order, counted after DTSTAMP is removed.",
  },
  name: {
    ...text,
    description:
      'Property name as exported, uppercased, including vendor X- names.',
  },
  value: {
    ...text,
    description:
      'Raw property value as exported after line unfolding: no TEXT unescaping, date parsing or decoding. An inline ATTACH value is a whole base64 file.',
  },
} as const;

export class IcsPropertiesStream extends CalendarStream<
  typeof properties,
  IcsPropertyNode
> {
  readonly name = 'icsProperties';
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per property line of an icsComponents component, in export order, except DTSTAMP: EventKit sets it to the export time, so it is omitted. Values are raw iCalendar text; vendor X- properties are kept. ATTACH properties also appear in icsAttachments. Relationships name source streams, not destination tables.',
    properties,
    required: Object.keys(properties),
  } as const;
  override readonly requiresIcs = true;

  protected rows(scan: CalendarScan): readonly IcsPropertyNode[] {
    return scan.ics.properties;
  }

  protected record({
    item,
    componentId,
    id,
    position,
    property,
  }: IcsPropertyNode): RecordDraft<typeof properties> {
    return {
      id,
      componentId,
      calendarId: item.calendarId,
      calendarItemId: item.calendarItemId,
      position,
      name: property.name,
      value: property.value,
    };
  }
}
