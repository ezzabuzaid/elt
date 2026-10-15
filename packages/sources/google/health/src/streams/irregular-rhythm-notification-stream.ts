import type { DataPoint } from '@workspace/sdk-google-health';

import { fields, session } from '../health-fields.ts';
import { PointStream } from '../point-stream.ts';

export class IrregularRhythmNotificationStream extends PointStream {
  constructor() {
    super({
      type: 'irregular-rhythm-notification',
      name: 'irregularRhythmNotification',
      named: false,
      shared: true,
      description:
        "One record per irregular-rhythm-notification point Google Health holds for the user. Represents an Irregular Rhythm Notification alert, indicating a potential sign of atrial fibrillation (AFib). This data type is based on SaMD feature and any changes to it may require additional review. Google keeps no id for these points, so the stream declares no key. Several devices can record the same moment: Apple Health relays an iPhone's and an Apple Watch's points for one walk, beside a Fitbit's, so a total over every point counts it more than once; total one device's points (deviceFormFactor, deviceDisplayName, applicationPackageName). Reloaded whole on every run, so a point edited or deleted upstream is replaced or gone after the next run.",
      properties: {
        ...session.properties,
        medicalDeviceInfoAlgorithmVersion: {
          ...fields.text,
          description: 'The algorithm version used by the feature.',
        },
        medicalDeviceInfoDeviceModel: {
          ...fields.text,
          description:
            'The model name or device type of the compatible device used to collect the data.',
        },
        medicalDeviceInfoFeatureVersion: {
          ...fields.text,
          description: 'The version of the feature/app running on the device.',
        },
        medicalDeviceInfoFirmwareVersion: {
          ...fields.text,
          description:
            'The firmware version running on the compatible device used to collect the data.',
        },
        medicalDeviceInfoServiceVersion: {
          ...fields.text,
          description: 'The service version used by the feature.',
        },
      },
    });
  }

  protected row({ irregularRhythmNotification }: DataPoint) {
    return {
      ...session.row(irregularRhythmNotification?.interval),
      medicalDeviceInfoAlgorithmVersion:
        irregularRhythmNotification?.medicalDeviceInfo?.algorithmVersion ??
        null,
      medicalDeviceInfoDeviceModel:
        irregularRhythmNotification?.medicalDeviceInfo?.deviceModel ?? null,
      medicalDeviceInfoFeatureVersion:
        irregularRhythmNotification?.medicalDeviceInfo?.featureVersion ?? null,
      medicalDeviceInfoFirmwareVersion:
        irregularRhythmNotification?.medicalDeviceInfo?.firmwareVersion ?? null,
      medicalDeviceInfoServiceVersion:
        irregularRhythmNotification?.medicalDeviceInfo?.serviceVersion ?? null,
    };
  }
}
