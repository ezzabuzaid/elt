import type { ProtobufMessage } from '@workspace/codec-protobuf';
import type { RecordDraft } from '@workspace/elt';

import { activityFields, flag, integer, nonEmpty } from '../activity-values.ts';
import {
  type BiomeAddress,
  BiomeStream,
  biomeAddress,
} from '../biome-stream.ts';

const { integer: integerField } = activityFields;
const battery = (part: string) =>
  ({
    ...integerField,
    minimum: 0,
    maximum: 100,
    description: `Battery of the ${part}, percent (0 when not reported).`,
  }) as const;

const properties = {
  ...biomeAddress,
  address: {
    ...activityFields.text,
    description: 'Bluetooth address of the device.',
  },
  deviceName: {
    ...activityFields.nullableText,
    description: 'Name of the device; NULL when it had none.',
  },
  connected: {
    ...activityFields.boolean,
    description: 'Whether the device connected (true) or disconnected (false).',
  },
  vendorId: {
    ...integerField,
    description: 'Bluetooth vendor ID, such as 76 for Apple.',
  },
  productId: { ...integerField, description: 'Bluetooth product ID.' },
  deviceType: {
    ...integerField,
    description: 'Bluetooth device type as stored.',
  },
  appleAudioDevice: {
    ...activityFields.boolean,
    description: 'Whether it is Apple audio, such as AirPods.',
  },
  userWearing: {
    ...activityFields.boolean,
    description: 'Whether the user wore it, for headphones.',
  },
  batteryCase: battery('headphone case'),
  batteryLeft: battery('left headphone'),
  batteryRight: battery('right headphone'),
} as const;

export class BluetoothConnectionsStream extends BiomeStream<typeof properties> {
  readonly name = 'bluetoothConnections';
  readonly biomeName = 'Device.Wireless.Bluetooth';
  readonly retentionDays = 28;
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per Bluetooth device connecting or disconnecting on this Mac and the devices it syncs with (Biome Device.Wireless.Bluetooth).',
    properties,
    required: Object.keys(properties),
  } as const;

  protected record(
    payload: ProtobufMessage,
    address: BiomeAddress,
  ): RecordDraft<typeof properties> {
    return {
      ...address,
      address: payload.string(1),
      deviceName: nonEmpty(payload.string(2)),
      connected: flag(payload.uint(4)),
      vendorId: integer(payload.uint(11)),
      productId: integer(payload.uint(3)),
      deviceType: integer(payload.uint(5)),
      appleAudioDevice: flag(payload.uint(9)),
      userWearing: flag(payload.uint(10)),
      batteryCase: integer(payload.uint(6)),
      batteryLeft: integer(payload.uint(8)),
      batteryRight: integer(payload.uint(7)),
    };
  }
}
