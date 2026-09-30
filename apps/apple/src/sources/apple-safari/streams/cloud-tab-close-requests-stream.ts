import type { SchemaRecord } from 'elt';
import type { SafariScan } from '../safari-scan.ts';
import { SafariStream, safariFields } from '../safari-stream.ts';
import type { Row } from '../safari-values.ts';

const properties = {
  id: {
    ...safariFields.id,
    description: 'iCloud Tabs close request identifier.',
  },
  deviceId: {
    ...safariFields.id,
    description:
      'The device asked to close the tab; refers to cloudTabDevices.id.',
  },
  url: { ...safariFields.text, description: 'URL of the tab to close.' },
  tabId: {
    ...safariFields.id,
    description:
      'The tab to close; refers to cloudTabs.id while that device still lists it.',
  },
} as const;

export class CloudTabCloseRequestsStream extends SafariStream<
  typeof properties,
  Row
> {
  readonly name = 'cloudTabCloseRequests';
  readonly store = 'cloudTabs';
  readonly primaryKey = ['id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per pending request, made from any device, to close a tab on another device through iCloud Tabs (CloudTabs.db). Relationships name streams in this source, not physical destination tables.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: SafariScan): readonly Row[] {
    return scan.cloudTabs.closeRequests;
  }

  protected record(row: Row): SchemaRecord<typeof properties> {
    return {
      id: row.close_request_uuid as string,
      deviceId: row.destination_device_uuid as string,
      url: row.url as string,
      tabId: row.tab_uuid as string,
    };
  }
}
