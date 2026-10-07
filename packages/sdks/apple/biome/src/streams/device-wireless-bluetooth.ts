import type { ProtobufMessage } from '@workspace/codec-protobuf';

import { BiomeStream } from '../biome-stream.ts';
import { flag, optionalText } from '../biome-values.ts';

export type DeviceWirelessBluetoothEvent = {
  readonly address: string | undefined;
  readonly deviceName: string | undefined;
  readonly connected: boolean | undefined;
  readonly vendorId: number | undefined;
  readonly productId: number | undefined;
  readonly deviceType: number | undefined;
  readonly appleAudioDevice: boolean | undefined;
  readonly userWearing: boolean | undefined;
  // Battery percentages, 0 when the device reports none.
  readonly batteryCase: number | undefined;
  readonly batteryLeft: number | undefined;
  readonly batteryRight: number | undefined;
};

// A Bluetooth device connecting or disconnecting.
export class DeviceWirelessBluetooth extends BiomeStream<DeviceWirelessBluetoothEvent> {
  readonly name = 'Device.Wireless.Bluetooth';
  readonly maximumAgeDays = 28;

  decode(message: ProtobufMessage): DeviceWirelessBluetoothEvent {
    return {
      address: message.string(1),
      deviceName: optionalText(message.string(2)),
      connected: flag(message.uint(4)),
      vendorId: message.uint(11),
      productId: message.uint(3),
      deviceType: message.uint(5),
      appleAudioDevice: flag(message.uint(9)),
      userWearing: flag(message.uint(10)),
      batteryCase: message.uint(6),
      batteryLeft: message.uint(8),
      batteryRight: message.uint(7),
    };
  }
}
