import { AccountStream } from '../account-stream.ts';
import type { GoogleHealthScan } from '../google-health-scan.ts';
import { fields, instant } from '../health-fields.ts';

export class PairedDevicesStream extends AccountStream {
  constructor() {
    super({
      name: 'pairedDevices',
      description:
        "One record per device paired with the user's account, such as a Fitbit tracker or a scale. Primary key name. Reloaded whole on every run, so a device removed from the account is gone after the next run.",
      properties: {
        name: {
          type: 'string',
          minLength: 1,
          description:
            "The device's resource name, users/<id>/pairedDevices/<id>.",
        },
        deviceType: { ...fields.text, description: 'TRACKER or SCALE.' },
        deviceVersion: {
          ...fields.text,
          description: "The device's product name, such as Air.",
        },
        batteryStatus: {
          ...fields.text,
          description: 'High, Medium, Low or Empty.',
        },
        batteryLevel: {
          ...fields.integer,
          description: "The device's battery level, in percent.",
        },
        lastSyncTime: {
          ...fields.instant,
          description:
            'When the device last synced with the Google Health app.',
        },
        macAddress: {
          ...fields.text,
          description: "The device's MAC address.",
        },
        features: {
          ...fields.texts,
          description:
            'What the device can record, as Google names it, such as ACTIVE_MINUTES.',
        },
      },
      primaryKey: ['name'],
    });
  }

  protected async rows(
    scan: GoogleHealthScan,
    signal: AbortSignal | undefined,
  ) {
    const rows = [];
    for await (const device of scan.api.pairedDevices(signal && { signal }))
      rows.push({
        name: device.name,
        deviceType: device.deviceType ?? null,
        deviceVersion: device.deviceVersion ?? null,
        batteryStatus: device.batteryStatus ?? null,
        batteryLevel: device.batteryLevel ?? null,
        lastSyncTime: instant(device.lastSyncTime),
        macAddress: device.macAddress ?? null,
        features: device.features ?? [],
      });
    return rows;
  }
}
