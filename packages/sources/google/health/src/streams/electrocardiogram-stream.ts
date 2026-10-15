import type { DataPoint } from '@workspace/sdk-google-health';

import { fields, session } from '../health-fields.ts';
import { PointStream } from '../point-stream.ts';

export class ElectrocardiogramStream extends PointStream {
  constructor() {
    super({
      type: 'electrocardiogram',
      name: 'electrocardiogram',
      named: false,
      shared: false,
      description:
        "One record per electrocardiogram point Google Health holds for the user. Represents an Electrocardiogram (ECG) measurement session. This data type is based on SaMD feature and any changes to it may require additional review. Google keeps no id for these points, so the stream declares no key. Several devices can record the same moment: Apple Health relays an iPhone's and an Apple Watch's points for one walk, beside a Fitbit's, so a total over every point counts it more than once; total one device's points (deviceFormFactor, deviceDisplayName, applicationPackageName). Reloaded whole on every run, so a point edited or deleted upstream is replaced or gone after the next run.",
      properties: {
        beatsPerMinuteAvg: {
          ...fields.int64,
          description:
            'Average heart rate recorded during ECG reading in beats per minute.',
        },
        ...session.properties,
        leadNumber: {
          ...fields.integer,
          description: 'The number of leads used for ECG reading.',
        },
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
        millivoltsScalingFactor: {
          ...fields.integer,
          description:
            'The factor by which to divide waveform samples to get voltage in millivolts: millivolts = waveform_sample / millivolts_scaling_factor.',
        },
        resultClassification: {
          ...fields.text,
          description:
            'The result classification of the ECG reading. One of NORMAL_SINUS_RHYTHM, ATRIAL_FIBRILLATION, INCONCLUSIVE, INCONCLUSIVE_HIGH_HEART_RATE, INCONCLUSIVE_LOW_HEART_RATE, UNREADABLE, NOT_ANALYZED.',
        },
        samplingFrequencyHertz: {
          ...fields.integer,
          description: 'The sampling frequency of waveform samples in hertz.',
        },
        waveformSamples: {
          ...fields.integers,
          description:
            'An array of voltage values representing lead I ECG values. Each sample represents voltage difference in ECG graph. The first value in array corresponds to the start of the reading.',
        },
      },
    });
  }

  protected row({ electrocardiogram }: DataPoint) {
    return {
      beatsPerMinuteAvg: electrocardiogram?.beatsPerMinuteAvg ?? null,
      ...session.row(electrocardiogram?.interval),
      leadNumber: electrocardiogram?.leadNumber ?? null,
      medicalDeviceInfoAlgorithmVersion:
        electrocardiogram?.medicalDeviceInfo?.algorithmVersion ?? null,
      medicalDeviceInfoDeviceModel:
        electrocardiogram?.medicalDeviceInfo?.deviceModel ?? null,
      medicalDeviceInfoFeatureVersion:
        electrocardiogram?.medicalDeviceInfo?.featureVersion ?? null,
      medicalDeviceInfoFirmwareVersion:
        electrocardiogram?.medicalDeviceInfo?.firmwareVersion ?? null,
      medicalDeviceInfoServiceVersion:
        electrocardiogram?.medicalDeviceInfo?.serviceVersion ?? null,
      millivoltsScalingFactor:
        electrocardiogram?.millivoltsScalingFactor ?? null,
      resultClassification: electrocardiogram?.resultClassification ?? null,
      samplingFrequencyHertz: electrocardiogram?.samplingFrequencyHertz ?? null,
      waveformSamples: electrocardiogram?.waveformSamples ?? [],
    };
  }
}
