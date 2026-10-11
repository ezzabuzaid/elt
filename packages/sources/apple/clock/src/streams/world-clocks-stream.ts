import type { ClockSnapshot } from '@workspace/sdk-apple-clock/clock-store';

import { ClockStream, fields } from '../clock-stream.ts';

const properties = {
  position: {
    ...fields.position,
    description:
      'Zero-based position in the stored list; preserves order and repeated entries.',
  },
  cityId: {
    ...fields.integer,
    description: 'Apple city identifier, or null when not present.',
  },
  name: { ...fields.text, description: 'Saved localized city name.' },
  country: { ...fields.text, description: 'Saved localized country name.' },
  countryOverride: {
    ...fields.text,
    description: 'Saved localized country display override.',
  },
  unlocalizedName: { ...fields.text, description: 'Unlocalized city name.' },
  unlocalizedCountry: {
    ...fields.text,
    description: 'Unlocalized country name.',
  },
  unlocalizedCountryOverride: {
    ...fields.text,
    description: 'Unlocalized country display override.',
  },
  timeZone: {
    ...fields.text,
    description:
      'Stored timezone identifier; no current UTC offset is computed.',
  },
  countryCode: {
    ...fields.text,
    description: 'Stored city locale or country code.',
  },
  latitude: { ...fields.number, description: 'City latitude in degrees.' },
  longitude: { ...fields.number, description: 'City longitude in degrees.' },
  yahooCode: {
    ...fields.text,
    description: 'Legacy city lookup code stored by Apple.',
  },
  languageCode: {
    ...fields.text,
    description: 'Language used for this saved city.',
  },
  typeCode: {
    ...fields.integer,
    description:
      'Apple type code as stored; no undocumented labels are inferred.',
  },
  countryOnly: {
    ...fields.boolean,
    description: 'Whether the display name uses only the country.',
  },
} as const;

export class WorldClocksStream extends ClockStream<typeof properties> {
  readonly name = 'worldClocks';
  readonly store = 'cities';
  readonly description =
    'Saved world-clock cities in display order; current time and computed offsets are not persisted facts.';
  readonly properties = properties;
  readonly primaryKey = ['position'];
  protected rows(snapshot: ClockSnapshot) {
    return snapshot.cities;
  }
}
