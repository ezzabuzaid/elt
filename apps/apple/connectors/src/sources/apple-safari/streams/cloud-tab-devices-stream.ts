import type { RecordDraft } from '@workspace/elt';

import type { SafariScan } from '../safari-scan.ts';
import { SafariStream, safariFields } from '../safari-stream.ts';
import { type Row, appleTime, flag, text } from '../safari-values.ts';

const { boolean, nullableText } = safariFields;

const properties = {
  id: {
    ...safariFields.id,
    description:
      'iCloud Tabs device identifier; cloudTabs.deviceId and cloudTabCloseRequests.deviceId refer to it.',
  },
  name: {
    ...nullableText,
    description: 'Device name as the device reports it; NULL when absent.',
  },
  type: {
    ...nullableText,
    description:
      'Apple model identifier of the device, such as com.apple.iphone-15-pro-5; NULL when absent.',
  },
  duplicateName: {
    ...boolean,
    description: 'Whether another device on the account has the same name.',
  },
  ephemeral: {
    ...boolean,
    description: 'Whether Safari treats the device as temporary.',
  },
  modifiedAt: {
    ...safariFields.nullableTimestamp,
    description: 'When the device last changed its iCloud Tabs record.',
  },
} as const;

export class CloudTabDevicesStream extends SafariStream<
  typeof properties,
  Row
> {
  readonly name = 'cloudTabDevices';
  readonly store = 'cloudTabs';
  readonly primaryKey = ['id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per device sharing its open tabs through iCloud Tabs (CloudTabs.db), as Safari on this Mac last fetched them. Safari fetches only while it runs. Relationships name streams in this source, not physical destination tables.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: SafariScan): readonly Row[] {
    return scan.cloudTabs.devices;
  }

  protected record(row: Row): RecordDraft<typeof properties> {
    return {
      id: row.device_uuid,
      name: text(row.device_name),
      type: text(row.device_type_identifier),
      duplicateName: flag(row.has_duplicate_device_name),
      ephemeral: flag(row.is_ephemeral_device),
      modifiedAt: appleTime(row.last_modified),
    };
  }
}
