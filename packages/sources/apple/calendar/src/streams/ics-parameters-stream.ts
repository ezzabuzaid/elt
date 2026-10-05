import type { RecordDraft } from '@workspace/elt';

import type { CalendarScan, IcsPropertyNode } from '../calendar-scan.ts';
import { CalendarStream, calendarFields } from '../calendar-stream.ts';

const { id, icsItem, ordinal, text } = calendarFields;

const properties = {
  id: {
    ...id,
    description:
      'JSON [calendarId, calendarItemId, path, propertyPosition, position, valuePosition], extending the property id.',
  },
  propertyId: {
    ...id,
    description:
      'Owning property; refers to icsProperties.id within this source.',
  },
  componentId: {
    ...id,
    description:
      'Component of the owning property; refers to icsComponents.id within this source.',
  },
  ...icsItem,
  position: {
    ...ordinal,
    description: 'Index of the parameter within its property, in export order.',
  },
  valuePosition: {
    ...ordinal,
    description: 'Index of this value within the parameter.',
  },
  name: {
    ...text,
    description: 'Parameter name as exported, uppercased.',
  },
  value: {
    ...text,
    description:
      "One parameter value, with surrounding double quotes removed and RFC 6868 caret escapes (^n, ^', ^^) decoded; otherwise as exported.",
  },
} as const;

type Row = {
  readonly line: IcsPropertyNode;
  readonly position: number;
  readonly valuePosition: number;
  readonly name: string;
  readonly value: string;
};

export class IcsParametersStream extends CalendarStream<
  typeof properties,
  Row
> {
  readonly name = 'icsParameters';
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per value of each iCalendar property parameter: a comma-separated multi-value parameter yields one record per value. Relationships name source streams, not destination tables.',
    properties,
    required: Object.keys(properties),
  } as const;
  override readonly requiresIcs = true;

  protected rows(scan: CalendarScan): readonly Row[] {
    return scan.ics.properties.flatMap((line) =>
      line.property.parameters.flatMap(({ name, values }, position) =>
        values.map((value, valuePosition) => ({
          line,
          position,
          valuePosition,
          name,
          value,
        })),
      ),
    );
  }

  protected record({
    line,
    position,
    valuePosition,
    name,
    value,
  }: Row): RecordDraft<typeof properties> {
    return {
      id: JSON.stringify([...line.key, position, valuePosition]),
      propertyId: line.id,
      componentId: line.componentId,
      calendarId: line.item.calendarId,
      calendarItemId: line.item.calendarItemId,
      position,
      valuePosition,
      name,
      value,
    };
  }
}
