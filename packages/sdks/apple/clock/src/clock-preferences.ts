import { readFile } from 'node:fs/promises';

import { PlistDate, parseBinaryPlist } from '@workspace/codec-plist';

import { ClockUnavailableError } from './errors.ts';
import {
  array,
  dictionary,
  flag,
  instant,
  number,
  requiredText,
  text,
} from './values.ts';

async function preferences(path: string) {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (cause) {
    throw new ClockUnavailableError(path, cause);
  }
  return dictionary(parseBinaryPlist(bytes));
}

export async function worldClocks(path: string) {
  const root = await preferences(path);
  // An initialized preferences domain may have no saved cities yet.
  return array(root.cities === undefined ? [] : root.cities).map(
    (entry, position) => {
      const saved = dictionary(entry);
      const city = dictionary(saved.city);
      return {
        position,
        cityId: number(city.identifier),
        name: text(city.name),
        country: text(city.countryName),
        countryOverride: text(city.countryOverride),
        unlocalizedName: text(city.unlocalizedName),
        unlocalizedCountry: text(city.unlocalizedCountryName),
        unlocalizedCountryOverride: text(city.unlocalizedCountryOverride),
        timeZone: text(city.timeZone),
        countryCode: text(city.localeCode),
        latitude: number(city.latitude),
        longitude: number(city.longitude),
        yahooCode: text(city.yahooCode),
        languageCode: text(saved.languageCode),
        typeCode: number(saved.type),
        countryOnly: flag(city.displayNameIncludingCountryUsesOnlyCountry),
      };
    },
  );
}

export async function stopwatches(path: string) {
  const root = await preferences(path);
  const stored = root.MTStopwatches;
  if (stored === undefined) return [];
  return array(dictionary(stored).MTStopwatches).map((entry) => {
    const watch = dictionary(dictionary(entry).$MTStopwatch);
    return {
      id: requiredText(watch.MTStopwatchIdentifier),
      title: text(watch.MTStopwatchTitle),
      stateCode: number(watch.MTStopwatchState),
      currentInterval: number(watch.MTStopwatchCurrentInterval),
      offset: number(watch.MTStopwatchOffset),
      previousLapsTotal: number(watch.MTStopwatchPreviousLapsTotalInterval),
      // MTStorageWriter persists the start anchor as a native plist date.
      startedAt:
        watch.MTStopwatchStartDate === undefined
          ? null
          : date(watch.MTStopwatchStartDate),
      laps: array(watch.MTStopwatchLaps).map((lap) => {
        const interval = number(lap);
        if (interval === null) throw new TypeError('Clock lap has no interval');
        return interval;
      }),
    };
  });
}

function date(value: unknown): string | null {
  if (!(value instanceof PlistDate))
    throw new TypeError('Clock stopwatch start date is not a plist date');
  return instant(value.referenceSeconds);
}
