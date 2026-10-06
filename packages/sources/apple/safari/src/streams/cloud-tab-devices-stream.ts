import type { RecordDraft } from '@workspace/elt';
import type { CloudTabDevice } from '@workspace/sdk-apple-safari';

import type { SafariScan } from '../safari-scan.ts';
import { SafariStream, iso, safariFields } from '../safari-stream.ts';

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
  CloudTabDevice
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

  protected rows(scan: SafariScan): readonly CloudTabDevice[] {
    return scan.cloudTabs.devices;
  }

  protected record(device: CloudTabDevice): RecordDraft<typeof properties> {
    return {
      id: device.id,
      name: device.name,
      type: device.type,
      duplicateName: device.duplicateName,
      ephemeral: device.ephemeral,
      modifiedAt: iso(device.modifiedAt),
    };
  }
}
