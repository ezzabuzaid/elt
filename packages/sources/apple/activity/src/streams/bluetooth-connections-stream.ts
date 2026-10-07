import type { RecordDraft } from '@workspace/elt';
import {
  DeviceWirelessBluetooth,
  type DeviceWirelessBluetoothEvent,
} from '@workspace/sdk-apple-biome';

import { activityFields } from '../activity-values.ts';
import {
  BiomeActivityStream,
  type BiomeAddress,
  biomeAddress,
} from '../biome-activity-stream.ts';

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

export class BluetoothConnectionsStream extends BiomeActivityStream<
  typeof properties,
  DeviceWirelessBluetoothEvent
> {
  readonly name = 'bluetoothConnections';
  readonly biome = new DeviceWirelessBluetooth();
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per Bluetooth device connecting or disconnecting on this Mac and the devices it syncs with (Biome Device.Wireless.Bluetooth).',
    properties,
    required: Object.keys(properties),
  } as const;

  protected record(
    event: DeviceWirelessBluetoothEvent,
    address: BiomeAddress,
  ): RecordDraft<typeof properties> {
    return {
      ...address,
      address: event.address,
      deviceName: event.deviceName ?? null,
      connected: event.connected ?? null,
      vendorId: event.vendorId ?? null,
      productId: event.productId ?? null,
      deviceType: event.deviceType ?? null,
      appleAudioDevice: event.appleAudioDevice ?? null,
      userWearing: event.userWearing ?? null,
      batteryCase: event.batteryCase ?? null,
      batteryLeft: event.batteryLeft ?? null,
      batteryRight: event.batteryRight ?? null,
    };
  }
}
