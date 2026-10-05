import { randomUUID } from 'node:crypto';
import { lstat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

import type { RecordDraft, SchemaRecord } from '@workspace/elt';

import type { CalendarScan, IcsPropertyNode } from '../calendar-scan.ts';
import { CalendarStream, calendarFields } from '../calendar-stream.ts';

const { id, icsItem, text, nullableText, boolean } = calendarFields;

const properties = {
  id: {
    ...id,
    description: 'Same value as propertyId; the record key.',
  },
  propertyId: {
    ...id,
    description:
      'The ATTACH property; refers to icsProperties.id within this source.',
  },
  componentId: {
    ...id,
    description:
      'Component holding the ATTACH property; refers to icsComponents.id within this source.',
  },
  ...icsItem,
  uri: {
    ...text,
    description:
      'Raw ATTACH value: the base64 file content when inline is true, otherwise the attachment URI.',
  },
  filename: {
    ...nullableText,
    description:
      'First value of the ATTACH X-APPLE-FILENAME parameter, else of FILENAME; NULL when neither is present.',
  },
  formatType: {
    ...nullableText,
    description:
      'First value of the ATTACH FMTTYPE parameter, a media type; NULL when absent.',
  },
  inline: {
    ...boolean,
    description:
      'Whether ATTACH carries VALUE=BINARY or ENCODING=BASE64, so uri holds the file content itself rather than a location.',
  },
} as const;

export class IcsAttachmentsStream extends CalendarStream<
  typeof properties,
  IcsPropertyNode
> {
  readonly name = 'icsAttachments';
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per ATTACH property in the ICS export; the same property also remains in icsProperties with its parameters in icsParameters. File bytes can be inline (base64 in uri), remote (retrieved only by the attachment fetcher the app supplies) or unavailable: an attachment record exists even when no bytes are exported. Relationships name source streams, not destination tables.',
    properties,
    required: Object.keys(properties),
  } as const;
  readonly supportsFileTransfer = true;
  override readonly requiresIcs = true;

  protected rows(scan: CalendarScan): readonly IcsPropertyNode[] {
    return scan.ics.properties.filter(
      ({ property }) => property.name === 'ATTACH',
    );
  }

  protected record({
    item,
    componentId,
    id,
    property,
  }: IcsPropertyNode): RecordDraft<typeof properties> {
    const parameter = (key: string) =>
      property.parameters.find((candidate) => candidate.name === key)
        ?.values[0] ?? null;
    return {
      id,
      propertyId: id,
      componentId,
      calendarId: item.calendarId,
      calendarItemId: item.calendarItemId,
      uri: property.value,
      filename: parameter('X-APPLE-FILENAME') ?? parameter('FILENAME'),
      formatType: parameter('FMTTYPE'),
      // RFC 5545 inline content: the value is the base64 file itself.
      inline:
        parameter('VALUE') === 'BINARY' || parameter('ENCODING') === 'BASE64',
    };
  }

  // An inline attachment carries its bytes; a remote one is retrieved by the
  // app's fetcher, which reports a file it cannot reach as missing.
  override async file(
    attachment: SchemaRecord<typeof properties>,
    scan: CalendarScan,
    staging: string,
  ): Promise<string | null> {
    const extension =
      attachment.filename === null ? '' : extname(attachment.filename);
    const path = join(staging, `${randomUUID()}${extension}`);
    if (attachment.inline) {
      await writeFile(path, Buffer.from(attachment.uri, 'base64'));
      return path;
    }
    const { uri, filename, formatType, calendarId, calendarItemId } =
      attachment;
    const fetched = await scan.fetch(
      { uri, filename, formatType, calendarId, calendarItemId },
      path,
    );
    if (!fetched) return null;
    if (!(await lstat(path)).isFile())
      throw new TypeError(
        'The attachment fetcher did not write a regular file',
      );
    return path;
  }
}
