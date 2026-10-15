import { AccountStream } from '../account-stream.ts';
import type { GoogleHealthScan } from '../google-health-scan.ts';
import { fields, seconds } from '../health-fields.ts';

export class SettingsStream extends AccountStream {
  constructor() {
    super({
      name: 'settings',
      description:
        "One record: the units, locale and time zone in the user's Google Health settings. Reloaded whole on every run.",
      properties: {
        timeZone: {
          ...fields.text,
          description: "The user's IANA time zone, such as Asia/Amman.",
        },
        utcOffsetSeconds: {
          ...fields.integer,
          description: "The user's offset from UTC, in seconds.",
        },
        languageLocale: { ...fields.text, description: "The user's locale." },
        foodLanguageCode: {
          ...fields.text,
          description:
            "The language of the user's food database, such as en-US.",
        },
        distanceUnit: {
          ...fields.text,
          description: 'DISTANCE_UNIT_MILES or DISTANCE_UNIT_KILOMETERS.',
        },
        glucoseUnit: {
          ...fields.text,
          description: 'GLUCOSE_UNIT_MG_DL or GLUCOSE_UNIT_MMOL_L.',
        },
        heightUnit: {
          ...fields.text,
          description: 'HEIGHT_UNIT_INCHES or HEIGHT_UNIT_CENTIMETERS.',
        },
        swimUnit: {
          ...fields.text,
          description: 'SWIM_UNIT_METERS or SWIM_UNIT_YARDS.',
        },
        temperatureUnit: {
          ...fields.text,
          description:
            'TEMPERATURE_UNIT_CELSIUS or TEMPERATURE_UNIT_FAHRENHEIT.',
        },
        waterUnit: {
          ...fields.text,
          description: 'WATER_UNIT_ML, WATER_UNIT_FL_OZ or WATER_UNIT_CUP.',
        },
        weightUnit: {
          ...fields.text,
          description:
            'WEIGHT_UNIT_POUNDS, WEIGHT_UNIT_STONE or WEIGHT_UNIT_KILOGRAMS.',
        },
        autoStrideEnabled: {
          ...fields.boolean,
          description: "Whether Google calculates the user's stride length.",
        },
        strideLengthWalkingType: {
          ...fields.text,
          description:
            'STRIDE_LENGTH_TYPE_DEFAULT, STRIDE_LENGTH_TYPE_MANUAL or STRIDE_LENGTH_TYPE_AUTO, for walking.',
        },
        strideLengthRunningType: {
          ...fields.text,
          description:
            'STRIDE_LENGTH_TYPE_DEFAULT, STRIDE_LENGTH_TYPE_MANUAL or STRIDE_LENGTH_TYPE_AUTO, for running.',
        },
      },
    });
  }

  protected async rows(
    scan: GoogleHealthScan,
    signal: AbortSignal | undefined,
  ) {
    const settings = await scan.api.settings(signal && { signal });
    return [
      {
        timeZone: settings.timeZone ?? null,
        utcOffsetSeconds: seconds(settings.utcOffset),
        languageLocale: settings.languageLocale ?? null,
        foodLanguageCode: settings.foodLanguageCode ?? null,
        distanceUnit: settings.distanceUnit ?? null,
        glucoseUnit: settings.glucoseUnit ?? null,
        heightUnit: settings.heightUnit ?? null,
        swimUnit: settings.swimUnit ?? null,
        temperatureUnit: settings.temperatureUnit ?? null,
        waterUnit: settings.waterUnit ?? null,
        weightUnit: settings.weightUnit ?? null,
        autoStrideEnabled: settings.autoStrideEnabled ?? null,
        strideLengthWalkingType: settings.strideLengthWalkingType ?? null,
        strideLengthRunningType: settings.strideLengthRunningType ?? null,
      },
    ];
  }
}
