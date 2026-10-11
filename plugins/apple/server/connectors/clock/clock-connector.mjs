import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
import {
  PlistDate,
  decodeArchive,
  isDictionary,
  parseBinaryPlist,
  plistJSON
} from "../../chunks/chunk-CWCLYXDX.mjs";
import {
  localAppleStoreCoverage
} from "../../chunks/chunk-BRJ4TKR5.mjs";
import {
  AppDatabase,
  AppDatabaseVersion,
  referenceDateInstant
} from "../../chunks/chunk-DV4S52G7.mjs";
import {
  AppleConnector
} from "../../chunks/chunk-G5BWDLSD.mjs";
import "../../chunks/chunk-ORGWIAHM.mjs";
import {
  Catalog,
  Source,
  Stream,
  diffSnapshot,
  validateRecords
} from "../../chunks/chunk-2UKXR4JG.mjs";
import {
  __callDispose,
  __using
} from "../../chunks/chunk-ZGXE7NZW.mjs";

// packages/sources/apple/clock/dist/apple-clock-source.js
import { setInterval } from "node:timers/promises";

// packages/sdks/apple/clock/dist/clock-store.js
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// packages/sdks/apple/clock/dist/errors.js
var ClockUnavailableError = class extends Error {
  name = "ClockUnavailableError";
  constructor(path, cause) {
    super(`The Clock store at ${path} cannot be read. Open Clock once. If macOS denies access, allow the process running the import Full Disk Access in System Settings > Privacy & Security.`, { cause });
  }
};
var ClockSchemaError = class extends Error {
  name = "ClockSchemaError";
  constructor(path, missing) {
    super(`The Clock store at ${path} has an unsupported layout (missing ${missing.join(", ")}).`);
  }
};

// packages/sdks/apple/clock/dist/values.js
function dictionary(value) {
  if (!isDictionary(value))
    throw new TypeError("Clock expected a property-list dictionary");
  return value;
}
function array(value) {
  if (!Array.isArray(value))
    throw new TypeError("Clock expected a property-list array");
  return value;
}
function text(value) {
  if (value === null || value === void 0)
    return null;
  if (typeof value !== "string")
    throw new TypeError("Clock expected text");
  return value;
}
function requiredText(value) {
  const result = text(value);
  if (!result)
    throw new TypeError("Clock record has no identifier");
  return result;
}
function number(value) {
  if (value === null || value === void 0)
    return null;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new TypeError("Clock expected a finite number");
  return value;
}
function flag(value) {
  if (value === null || value === void 0)
    return null;
  if (value === true || value === 1)
    return true;
  if (value === false || value === 0)
    return false;
  throw new TypeError("Clock expected a boolean");
}
function instant(value) {
  const seconds = number(value);
  return seconds === null ? null : referenceDateInstant(seconds);
}
function uuid(value) {
  if (!(value instanceof Uint8Array) || value.length !== 16)
    throw new TypeError("Clock UUID is not 16 bytes");
  const hex = Buffer.from(value).toString("hex").toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function bytes(value) {
  if (value === null)
    return null;
  if (!(value instanceof Uint8Array))
    throw new TypeError("Clock expected binary data");
  return Buffer.from(value).toString("base64");
}
function timerTime(value) {
  if (value === null)
    return { fireAt: null, remainingSeconds: null, fireTime: null };
  if (!(value instanceof Uint8Array))
    throw new TypeError("Clock timer fire time is not an archive");
  const decoded = dictionary(decodeArchive(value));
  let fireAt = null;
  let remainingSeconds = null;
  if (decoded.$class === "MTTimerDate") {
    if (!(decoded.MTTimerTimeDate instanceof PlistDate))
      throw new TypeError("Clock timer date archive has no date");
    fireAt = instant(decoded.MTTimerTimeDate.referenceSeconds);
  } else if (decoded.$class === "MTTimerTimeInterval") {
    remainingSeconds = number(decoded.MTTimerTimeInterval);
  } else
    throw new TypeError(`Unknown Clock timer fire-time class ${text(decoded.$class)}`);
  return {
    fireAt,
    remainingSeconds,
    fireTime: plistJSON(parseBinaryPlist(value))
  };
}

// packages/sdks/apple/clock/dist/clock-database.js
var columns = {
  ZMTCDALARM: [
    "ZMTID",
    "ZTITLE",
    "ZENABLED",
    "ZHOUR",
    "ZMINUTE",
    "ZDAY",
    "ZMONTH",
    "ZYEAR",
    "ZREPEATSCHEDULE",
    "ZALLOWSSNOOZE",
    "ZSNOOZEDURATION",
    "ZSLEEPALARM",
    "ZSLEEPSCHEDULE",
    "ZSILENTMODEOPTIONS",
    "ZCOORDINATIONPOLICY",
    "ZDISMISSEDACTION",
    "ZDISMISSEDDATE",
    "ZFIREDDATE",
    "ZKEEPOFFUNTILDATE",
    "ZLASTMODIFIEDDATE",
    "ZSNOOZEFIREDATE",
    "ZSOUND",
    "ZSIRICONTEXT"
  ],
  ZMTCDTIMER: [
    "ZMTID",
    "ZTITLE",
    "ZSTATE",
    "ZDURATION",
    "ZSOUND",
    "ZDISMISSEDDATE",
    "ZFIREDDATE",
    "ZLASTMODIFIEDDATE",
    "ZTIMERURL",
    "ZSIRICONTEXT",
    "ZTIMERCONTEXT",
    "ZFIRETIME"
  ],
  ZMTCDTIMERDURATION: [
    "Z_PK",
    "ZTITLE",
    "ZDURATION",
    "ZISFAVORITE",
    "ZLATEST",
    "ZVALIDRECENT",
    "ZLASTMODIFIED",
    "ZSOUND"
  ],
  ZMTCDSOUND: [
    "Z_PK",
    "ZSOUNDTYPE",
    "ZVOLUMELEVEL",
    "ZTONEIDENTIFIER",
    "ZVIBRATIONIDENTIFIER",
    "ZMEDIAITEMIDENTIFIER"
  ],
  ZMTCDCALENDARRELEASE: [
    "Z_PK",
    "ZREGION",
    "ZYEAR",
    "ZRELEASEDATE",
    "ZLASTCHECKEDDATE"
  ],
  ZMTCDMAKEUPDAY: ["Z_PK", "ZDATE", "ZTYPE", "ZCALENDARRELEASE"],
  ZMTCDREPORT: ["Z_PK", "ZDATE", "ZCONCERNS"]
};
var ClockDatabase = class {
  #database;
  constructor(path) {
    this.#database = new AppDatabase(path, ClockUnavailableError);
    this.#database.requireColumns(columns, ClockSchemaError);
  }
  alarms() {
    return this.#database.all(`SELECT ZMTID AS "id", ZTITLE AS "title", ZENABLED AS "enabled", ZHOUR AS "hour", ZMINUTE AS "minute", ZDAY AS "day", ZMONTH AS "month", ZYEAR AS "year", ZREPEATSCHEDULE AS "repeatSchedule", ZALLOWSSNOOZE AS "allowsSnooze", ZSNOOZEDURATION AS "snoozeMinutes", ZSLEEPALARM AS "sleepAlarm", ZSLEEPSCHEDULE AS "sleepSchedule", ZSILENTMODEOPTIONS AS "silentModeOptions", ZCOORDINATIONPOLICY AS "coordinationPolicy", ZDISMISSEDACTION AS "dismissedAction", ZDISMISSEDDATE AS "dismissedAt", ZFIREDDATE AS "firedAt", ZKEEPOFFUNTILDATE AS "keepOffUntil", ZLASTMODIFIEDDATE AS "modifiedAt", ZSNOOZEFIREDATE AS "snoozeFireAt", CAST(ZSOUND AS TEXT) AS "soundId", ZSIRICONTEXT AS "siriContext" FROM ZMTCDALARM ORDER BY Z_PK`).map((row) => ({
      id: uuid(row.id),
      title: text(row.title),
      enabled: flag(row.enabled),
      hour: number(row.hour),
      minute: number(row.minute),
      day: number(row.day),
      month: number(row.month),
      year: number(row.year),
      repeatSchedule: number(row.repeatSchedule),
      allowsSnooze: flag(row.allowsSnooze),
      snoozeMinutes: number(row.snoozeMinutes),
      sleepAlarm: flag(row.sleepAlarm),
      sleepSchedule: flag(row.sleepSchedule),
      silentModeOptions: number(row.silentModeOptions),
      coordinationPolicy: number(row.coordinationPolicy),
      dismissedAction: number(row.dismissedAction),
      dismissedAt: instant(row.dismissedAt),
      firedAt: instant(row.firedAt),
      keepOffUntil: instant(row.keepOffUntil),
      modifiedAt: instant(row.modifiedAt),
      snoozeFireAt: instant(row.snoozeFireAt),
      soundId: text(row.soundId),
      siriContext: bytes(row.siriContext)
    }));
  }
  timers() {
    return this.#database.all(`SELECT ZMTID AS "id", ZTITLE AS "title", ZSTATE AS "stateCode", ZDURATION AS "duration", CAST(ZSOUND AS TEXT) AS "soundId", ZDISMISSEDDATE AS "dismissedAt", ZFIREDDATE AS "firedAt", ZLASTMODIFIEDDATE AS "modifiedAt", ZTIMERURL AS "url", ZSIRICONTEXT AS "siriContext", ZTIMERCONTEXT AS "timerContext", ZFIRETIME AS fireTime FROM ZMTCDTIMER ORDER BY Z_PK`).map((row) => ({
      id: uuid(row.id),
      title: text(row.title),
      stateCode: number(row.stateCode),
      duration: number(row.duration),
      soundId: text(row.soundId),
      dismissedAt: instant(row.dismissedAt),
      firedAt: instant(row.firedAt),
      modifiedAt: instant(row.modifiedAt),
      url: text(row.url),
      siriContext: bytes(row.siriContext),
      timerContext: bytes(row.timerContext),
      ...timerTime(row.fireTime)
    }));
  }
  timerDurations() {
    return this.#database.all(`SELECT CAST(Z_PK AS TEXT) AS "id", ZTITLE AS "title", ZDURATION AS "duration", ZISFAVORITE AS "favorite", ZLATEST AS "latest", ZVALIDRECENT AS "validRecent", ZLASTMODIFIED AS "modifiedAt", CAST(ZSOUND AS TEXT) AS "soundId" FROM ZMTCDTIMERDURATION ORDER BY Z_PK`).map((row) => ({
      id: requiredText(row.id),
      title: text(row.title),
      duration: number(row.duration),
      favorite: flag(row.favorite),
      latest: flag(row.latest),
      validRecent: flag(row.validRecent),
      modifiedAt: instant(row.modifiedAt),
      soundId: text(row.soundId)
    }));
  }
  sounds() {
    return this.#database.all(`SELECT CAST(Z_PK AS TEXT) AS "id", ZSOUNDTYPE AS "typeCode", ZVOLUMELEVEL AS "volume", ZTONEIDENTIFIER AS "toneId", ZVIBRATIONIDENTIFIER AS "vibrationId", CAST(ZMEDIAITEMIDENTIFIER AS TEXT) AS "mediaItemId" FROM ZMTCDSOUND ORDER BY Z_PK`).map((row) => ({
      id: requiredText(row.id),
      typeCode: number(row.typeCode),
      volume: number(row.volume),
      toneId: text(row.toneId),
      vibrationId: text(row.vibrationId),
      mediaItemId: text(row.mediaItemId)
    }));
  }
  calendarReleases() {
    return this.#database.all(`SELECT CAST(Z_PK AS TEXT) AS "id", ZREGION AS "region", ZYEAR AS "year", ZRELEASEDATE AS "releasedAt", ZLASTCHECKEDDATE AS "checkedAt" FROM ZMTCDCALENDARRELEASE ORDER BY Z_PK`).map((row) => ({
      id: requiredText(row.id),
      region: text(row.region),
      year: text(row.year),
      releasedAt: instant(row.releasedAt),
      checkedAt: instant(row.checkedAt)
    }));
  }
  makeupDays() {
    return this.#database.all(`SELECT CAST(Z_PK AS TEXT) AS "id", ZDATE AS "date", ZTYPE AS "typeCode", CAST(ZCALENDARRELEASE AS TEXT) AS "calendarReleaseId" FROM ZMTCDMAKEUPDAY ORDER BY Z_PK`).map((row) => ({
      id: requiredText(row.id),
      date: instant(row.date),
      typeCode: number(row.typeCode),
      calendarReleaseId: text(row.calendarReleaseId)
    }));
  }
  reports() {
    return this.#database.all(`SELECT CAST(Z_PK AS TEXT) AS "id", ZDATE AS "date", ZCONCERNS AS "concerns" FROM ZMTCDREPORT ORDER BY Z_PK`).map((row) => ({
      id: requiredText(row.id),
      date: instant(row.date),
      concerns: number(row.concerns)
    }));
  }
  [Symbol.dispose]() {
    this.#database[Symbol.dispose]();
  }
};

// packages/sdks/apple/clock/dist/clock-preferences.js
import { readFile } from "node:fs/promises";
async function preferences(path) {
  let bytes2;
  try {
    bytes2 = await readFile(path);
  } catch (cause) {
    throw new ClockUnavailableError(path, cause);
  }
  return dictionary(parseBinaryPlist(bytes2));
}
async function worldClocks(path) {
  const root = await preferences(path);
  return array(root.cities === void 0 ? [] : root.cities).map((entry, position) => {
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
      countryOnly: flag(city.displayNameIncludingCountryUsesOnlyCountry)
    };
  });
}
async function stopwatches(path) {
  const root = await preferences(path);
  const stored = root.MTStopwatches;
  if (stored === void 0)
    return [];
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
      startedAt: watch.MTStopwatchStartDate === void 0 ? null : date(watch.MTStopwatchStartDate),
      laps: array(watch.MTStopwatchLaps).map((lap) => {
        const interval = number(lap);
        if (interval === null)
          throw new TypeError("Clock lap has no interval");
        return interval;
      })
    };
  });
}
function date(value) {
  if (!(value instanceof PlistDate))
    throw new TypeError("Clock stopwatch start date is not a plist date");
  return instant(value.referenceSeconds);
}

// packages/sdks/apple/clock/dist/clock-store.js
var clockLocation = Object.freeze({
  database: join(homedir(), "Library/Group Containers/group.com.apple.mobiletimerd/local.sqlite"),
  cities: join(homedir(), "Library/Containers/com.apple.clock/Data/Library/Preferences/com.apple.mobiletimer.plist"),
  stopwatches: join(homedir(), "Library/Preferences/com.apple.mobiletimerd.plist")
});
var ClockStore = class {
  #location;
  constructor(location = clockLocation) {
    this.#location = location;
  }
  open(stores) {
    return ClockSnapshot.open(this.#location, stores);
  }
  version(store) {
    return new ClockVersion(this.#location[store], store);
  }
};
var ClockSnapshot = class _ClockSnapshot {
  #database;
  #cities;
  #stopwatches;
  #errors = /* @__PURE__ */ new Map();
  static async open(location, stores) {
    const snapshot = new _ClockSnapshot();
    for (const store of stores) {
      try {
        switch (store) {
          case "database":
            snapshot.#database = new ClockDatabase(location.database);
            break;
          case "cities":
            snapshot.#cities = await worldClocks(location.cities);
            break;
          case "stopwatches":
            snapshot.#stopwatches = await stopwatches(location.stopwatches);
            break;
        }
      } catch (error) {
        snapshot.#errors.set(store, error);
      }
    }
    return snapshot;
  }
  get database() {
    this.#check("database");
    if (!this.#database)
      throw new Error("Clock database was not selected");
    return this.#database;
  }
  get cities() {
    this.#check("cities");
    if (!this.#cities)
      throw new Error("Clock cities were not selected");
    return this.#cities;
  }
  get stopwatches() {
    this.#check("stopwatches");
    if (!this.#stopwatches)
      throw new Error("Clock stopwatches were not selected");
    return this.#stopwatches;
  }
  async [Symbol.asyncDispose]() {
    this.#database?.[Symbol.dispose]();
  }
  #check(store) {
    if (this.#errors.has(store))
      throw this.#errors.get(store);
  }
};
var ClockVersion = class {
  #path;
  #database;
  constructor(path, store) {
    this.#path = path;
    if (store === "database")
      this.#database = new AppDatabaseVersion(path, ClockUnavailableError);
  }
  async current() {
    if (this.#database)
      return String(this.#database.current);
    try {
      const { ino, size, mtimeNs } = await stat(this.#path, { bigint: true });
      return `${ino}:${size}:${mtimeNs}`;
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
        return "missing";
      throw new ClockUnavailableError(this.#path, cause);
    }
  }
  [Symbol.dispose]() {
    this.#database?.[Symbol.dispose]();
  }
};

// packages/sources/apple/clock/dist/clock-stream.js
var fields = {
  id: { type: "string", minLength: 1 },
  text: { type: ["string", "null"] },
  number: { type: ["number", "null"] },
  integer: { type: ["integer", "null"] },
  boolean: { type: ["boolean", "null"] },
  instant: { type: ["string", "null"], format: "date-time", precision: 6 },
  bytes: { type: ["string", "null"], contentEncoding: "base64" },
  int64: { type: ["string", "null"], format: "int64" },
  position: { type: "integer", minimum: 0 }
};
var ClockStream = class {
  #stream;
  describe() {
    this.#stream ??= new Stream({
      name: this.name,
      jsonSchema: {
        type: "object",
        description: this.description,
        properties: this.properties,
        required: Object.keys(this.properties)
      },
      primaryKey: this.primaryKey,
      supportedSyncModes: ["full_refresh", "incremental"],
      sourceDefinedCursor: true,
      emitsDeletes: true
    });
    return this.#stream;
  }
  read(snapshot) {
    return validateRecords({ name: this.name, jsonSchema: { properties: this.properties } }, this.rows(snapshot), "Clock");
  }
};

// packages/sources/apple/clock/dist/streams/alarms-stream.js
var properties = {
  id: {
    ...fields.id,
    description: "Identifier of this stored object. UUIDs come from MobileTimer; decimal IDs are Core Data row identifiers."
  },
  title: {
    ...fields.text,
    description: "Label saved in Clock; null when none is stored."
  },
  enabled: { ...fields.boolean, description: "Whether the alarm is enabled." },
  hour: {
    ...fields.integer,
    description: "Local alarm hour, without a timezone conversion."
  },
  minute: { ...fields.integer, description: "Local alarm minute." },
  day: {
    ...fields.integer,
    description: "Stored calendar day component; zero for an ordinary time-only alarm."
  },
  month: {
    ...fields.integer,
    description: "Stored calendar month component; zero for an ordinary time-only alarm."
  },
  year: {
    ...fields.integer,
    description: "Calendar year stored by MobileTimer."
  },
  repeatSchedule: {
    ...fields.integer,
    description: "Apple repeat-schedule bitmask, preserved as stored; Monday uses bit 0 in the inspected Clock version."
  },
  allowsSnooze: {
    ...fields.boolean,
    description: "Whether snoozing is allowed."
  },
  snoozeMinutes: {
    ...fields.integer,
    description: "Configured snooze duration in minutes."
  },
  sleepAlarm: {
    ...fields.boolean,
    description: "Whether this is a sleep alarm."
  },
  sleepSchedule: {
    ...fields.boolean,
    description: "Stored sleep-schedule flag."
  },
  silentModeOptions: {
    ...fields.integer,
    description: "Apple silent-mode option bits, as stored."
  },
  coordinationPolicy: {
    ...fields.integer,
    description: "Apple alarm coordination policy code, as stored."
  },
  dismissedAction: {
    ...fields.integer,
    description: "Apple code describing the last dismissal action."
  },
  dismissedAt: {
    ...fields.instant,
    description: "Last stored dismissal instant in UTC, to microseconds."
  },
  firedAt: {
    ...fields.instant,
    description: "Last stored firing instant in UTC, to microseconds."
  },
  keepOffUntil: {
    ...fields.instant,
    description: "Instant until which the alarm is kept off, in UTC."
  },
  modifiedAt: {
    ...fields.instant,
    description: "Stored modification instant in UTC, to microseconds; no import time is substituted."
  },
  snoozeFireAt: {
    ...fields.instant,
    description: "Stored snooze deadline in UTC."
  },
  soundId: {
    ...fields.text,
    description: "Identifier of the associated sounds row, or null."
  },
  siriContext: {
    ...fields.bytes,
    description: "Opaque Siri context bytes as base64, or null."
  }
};
var AlarmsStream = class extends ClockStream {
  name = "alarms";
  store = "database";
  description = "Saved Clock alarms, including disabled and sleep alarms; local time components and repeat bitmask are stored without applying a timezone.";
  properties = properties;
  primaryKey = ["id"];
  rows(snapshot) {
    return snapshot.database.alarms();
  }
};

// packages/sources/apple/clock/dist/streams/calendar-releases-stream.js
var properties2 = {
  id: {
    ...fields.id,
    description: "Identifier of this stored object. UUIDs come from MobileTimer; decimal IDs are Core Data row identifiers."
  },
  region: {
    ...fields.text,
    description: "Region code associated with the calendar release."
  },
  year: { ...fields.text, description: "Calendar year stored by MobileTimer." },
  releasedAt: {
    ...fields.instant,
    description: "Calendar release instant in UTC."
  },
  checkedAt: {
    ...fields.instant,
    description: "Last calendar-release check instant in UTC."
  }
};
var CalendarReleasesStream = class extends ClockStream {
  name = "calendarReleases";
  store = "database";
  description = "Regional calendar releases MobileTimer stores for adjusted workday alarm schedules.";
  properties = properties2;
  primaryKey = ["id"];
  rows(snapshot) {
    return snapshot.database.calendarReleases();
  }
};

// packages/sources/apple/clock/dist/streams/makeup-days-stream.js
var properties3 = {
  id: {
    ...fields.id,
    description: "Identifier of this stored object. UUIDs come from MobileTimer; decimal IDs are Core Data row identifiers."
  },
  date: {
    ...fields.instant,
    description: "Date value stored by MobileTimer, expressed as its UTC instant."
  },
  typeCode: {
    ...fields.integer,
    description: "Apple type code as stored; no undocumented labels are inferred."
  },
  calendarReleaseId: {
    ...fields.text,
    description: "Identifier of the parent calendarReleases row."
  }
};
var MakeupDaysStream = class extends ClockStream {
  name = "makeupDays";
  store = "database";
  description = "Workday adjustments in MobileTimer calendar releases; type codes kept as stored.";
  properties = properties3;
  primaryKey = ["id"];
  rows(snapshot) {
    return snapshot.database.makeupDays();
  }
};

// packages/sources/apple/clock/dist/streams/reports-stream.js
var properties4 = {
  id: {
    ...fields.id,
    description: "Identifier of this stored object. UUIDs come from MobileTimer; decimal IDs are Core Data row identifiers."
  },
  date: {
    ...fields.instant,
    description: "Date value stored by MobileTimer, expressed as its UTC instant."
  },
  concerns: {
    ...fields.integer,
    description: "MobileTimer report concern code, as stored."
  }
};
var ReportsStream = class extends ClockStream {
  name = "reports";
  store = "database";
  description = "MobileTimer reports with their stored concern codes.";
  properties = properties4;
  primaryKey = ["id"];
  rows(snapshot) {
    return snapshot.database.reports();
  }
};

// packages/sources/apple/clock/dist/streams/sounds-stream.js
var properties5 = {
  id: {
    ...fields.id,
    description: "Identifier of this stored object. UUIDs come from MobileTimer; decimal IDs are Core Data row identifiers."
  },
  typeCode: {
    ...fields.integer,
    description: "Apple type code as stored; no undocumented labels are inferred."
  },
  volume: {
    ...fields.number,
    description: "Stored sound volume, preserving sentinel values such as -1."
  },
  toneId: { ...fields.text, description: "System tone identifier." },
  vibrationId: {
    ...fields.text,
    description: "System vibration identifier; may be an empty string."
  },
  mediaItemId: {
    ...fields.int64,
    description: "Media-library sound identifier as an exact signed 64-bit integer string."
  }
};
var SoundsStream = class extends ClockStream {
  name = "sounds";
  store = "database";
  description = "Sound configurations referenced by alarms, timers and retained timer durations.";
  properties = properties5;
  primaryKey = ["id"];
  rows(snapshot) {
    return snapshot.database.sounds();
  }
};

// packages/sources/apple/clock/dist/streams/stopwatch-laps-stream.js
var properties6 = {
  stopwatchId: {
    ...fields.id,
    description: "Identifier of the parent stopwatches row."
  },
  position: {
    ...fields.position,
    description: "Zero-based position in the stored list; preserves order and repeated entries."
  },
  interval: {
    ...fields.number,
    description: "Completed lap interval in seconds."
  }
};
var StopwatchLapsStream = class extends ClockStream {
  name = "stopwatchLaps";
  store = "stopwatches";
  description = "Completed laps of the current stopwatch, in stored order; reset removes them.";
  properties = properties6;
  primaryKey = ["stopwatchId", "position"];
  rows(snapshot) {
    return snapshot.stopwatches.flatMap((watch) => watch.laps.map((interval, position) => ({
      stopwatchId: watch.id,
      position,
      interval
    })));
  }
};

// packages/sources/apple/clock/dist/streams/stopwatches-stream.js
var properties7 = {
  id: {
    ...fields.id,
    description: "Identifier of this stored object. UUIDs come from MobileTimer; decimal IDs are Core Data row identifiers."
  },
  title: {
    ...fields.text,
    description: "Label saved in Clock; null when none is stored."
  },
  stateCode: {
    ...fields.integer,
    description: "Apple stopwatch state code, as stored."
  },
  currentInterval: {
    ...fields.number,
    description: "Saved current-lap interval in seconds, without adding elapsed wall time."
  },
  offset: {
    ...fields.number,
    description: "Saved stopwatch offset in seconds."
  },
  previousLapsTotal: {
    ...fields.number,
    description: "Total seconds in the completed laps, as stored."
  },
  startedAt: {
    ...fields.instant,
    description: "Saved current stopwatch start anchor in UTC, to microseconds."
  }
};
var StopwatchesStream = class extends ClockStream {
  name = "stopwatches";
  store = "stopwatches";
  description = "Current stopwatch state and saved timing anchors, not a historical session log.";
  properties = properties7;
  primaryKey = ["id"];
  rows(snapshot) {
    return snapshot.stopwatches.map(({ laps: _laps, ...watch }) => watch);
  }
};

// packages/sources/apple/clock/dist/streams/timer-durations-stream.js
var properties8 = {
  id: {
    ...fields.id,
    description: "Identifier of this stored object. UUIDs come from MobileTimer; decimal IDs are Core Data row identifiers."
  },
  title: {
    ...fields.text,
    description: "Label saved in Clock; null when none is stored."
  },
  duration: {
    ...fields.number,
    description: "Configured timer duration in seconds."
  },
  favorite: {
    ...fields.boolean,
    description: "Whether this retained timer duration is a favorite."
  },
  latest: {
    ...fields.boolean,
    description: "Whether this is the latest timer duration."
  },
  validRecent: {
    ...fields.boolean,
    description: "Whether MobileTimer considers the duration a valid recent timer."
  },
  modifiedAt: {
    ...fields.instant,
    description: "Stored modification instant in UTC, to microseconds; no import time is substituted."
  },
  soundId: {
    ...fields.text,
    description: "Identifier of the associated sounds row, or null."
  }
};
var TimerDurationsStream = class extends ClockStream {
  name = "timerDurations";
  store = "database";
  description = "Clock recent and favorite timer durations retained by MobileTimer, not a history of every timer run.";
  properties = properties8;
  primaryKey = ["id"];
  rows(snapshot) {
    return snapshot.database.timerDurations();
  }
};

// packages/sources/apple/clock/dist/streams/timers-stream.js
var properties9 = {
  id: {
    ...fields.id,
    description: "Identifier of this stored object. UUIDs come from MobileTimer; decimal IDs are Core Data row identifiers."
  },
  title: {
    ...fields.text,
    description: "Label saved in Clock; null when none is stored."
  },
  stateCode: {
    ...fields.integer,
    description: "Apple timer state code: 1 stopped, 2 paused, 3 running."
  },
  duration: {
    ...fields.number,
    description: "Configured timer duration in seconds."
  },
  soundId: {
    ...fields.text,
    description: "Identifier of the associated sounds row, or null."
  },
  dismissedAt: {
    ...fields.instant,
    description: "Last stored dismissal instant in UTC, to microseconds."
  },
  firedAt: {
    ...fields.instant,
    description: "Last stored firing instant in UTC, to microseconds."
  },
  modifiedAt: {
    ...fields.instant,
    description: "Stored modification instant in UTC, to microseconds; no import time is substituted."
  },
  url: { ...fields.text, description: "Clock URL identifying the timer." },
  siriContext: {
    ...fields.bytes,
    description: "Opaque Siri context bytes as base64, or null."
  },
  timerContext: {
    ...fields.bytes,
    description: "Opaque timer context bytes as base64, or null."
  },
  fireAt: {
    ...fields.instant,
    description: "Running timer deadline in UTC, to microseconds; null for interval-based timers."
  },
  remainingSeconds: {
    ...fields.number,
    description: "Stored remaining seconds for a stopped or paused timer; null for a running deadline."
  },
  fireTime: {
    ...fields.text,
    description: "Original keyed fire-time archive as JSON, retaining class and reference-date seconds."
  }
};
var TimersStream = class extends ClockStream {
  name = "timers";
  store = "database";
  description = "Current stored timers, including the stopped default timer; running deadlines and paused remaining durations are stored without a moving countdown.";
  properties = properties9;
  primaryKey = ["id"];
  rows(snapshot) {
    return snapshot.database.timers();
  }
};

// packages/sources/apple/clock/dist/streams/world-clocks-stream.js
var properties10 = {
  position: {
    ...fields.position,
    description: "Zero-based position in the stored list; preserves order and repeated entries."
  },
  cityId: {
    ...fields.integer,
    description: "Apple city identifier, or null when not present."
  },
  name: { ...fields.text, description: "Saved localized city name." },
  country: { ...fields.text, description: "Saved localized country name." },
  countryOverride: {
    ...fields.text,
    description: "Saved localized country display override."
  },
  unlocalizedName: { ...fields.text, description: "Unlocalized city name." },
  unlocalizedCountry: {
    ...fields.text,
    description: "Unlocalized country name."
  },
  unlocalizedCountryOverride: {
    ...fields.text,
    description: "Unlocalized country display override."
  },
  timeZone: {
    ...fields.text,
    description: "Stored timezone identifier; no current UTC offset is computed."
  },
  countryCode: {
    ...fields.text,
    description: "Stored city locale or country code."
  },
  latitude: { ...fields.number, description: "City latitude in degrees." },
  longitude: { ...fields.number, description: "City longitude in degrees." },
  yahooCode: {
    ...fields.text,
    description: "Legacy city lookup code stored by Apple."
  },
  languageCode: {
    ...fields.text,
    description: "Language used for this saved city."
  },
  typeCode: {
    ...fields.integer,
    description: "Apple type code as stored; no undocumented labels are inferred."
  },
  countryOnly: {
    ...fields.boolean,
    description: "Whether the display name uses only the country."
  }
};
var WorldClocksStream = class extends ClockStream {
  name = "worldClocks";
  store = "cities";
  description = "Saved world-clock cities in display order; current time and computed offsets are not persisted facts.";
  properties = properties10;
  primaryKey = ["position"];
  rows(snapshot) {
    return snapshot.cities;
  }
};

// packages/sources/apple/clock/dist/apple-clock-source.js
var alarmsReader = new AlarmsStream();
var timersReader = new TimersStream();
var timerDurationsReader = new TimerDurationsStream();
var soundsReader = new SoundsStream();
var calendarReleasesReader = new CalendarReleasesStream();
var makeupDaysReader = new MakeupDaysStream();
var reportsReader = new ReportsStream();
var worldClocksReader = new WorldClocksStream();
var stopwatchesReader = new StopwatchesStream();
var stopwatchLapsReader = new StopwatchLapsStream();
var readers = [
  alarmsReader,
  timersReader,
  timerDurationsReader,
  soundsReader,
  calendarReleasesReader,
  makeupDaysReader,
  reportsReader,
  worldClocksReader,
  stopwatchesReader,
  stopwatchLapsReader
];
var catalog = new Catalog(readers.map((reader) => reader.describe()));
function readerOf(stream) {
  const reader = readers.find((reader2) => reader2.name === stream.name);
  if (!reader)
    throw new Error(`Clock has no ${stream.name} stream`);
  return reader;
}
var AppleClockSource = class extends Source {
  identity;
  catalog = catalog;
  #store;
  alarms = alarmsReader.describe();
  timers = timersReader.describe();
  timerDurations = timerDurationsReader.describe();
  sounds = soundsReader.describe();
  calendarReleases = calendarReleasesReader.describe();
  makeupDays = makeupDaysReader.describe();
  reports = reportsReader.describe();
  worldClocks = worldClocksReader.describe();
  stopwatches = stopwatchesReader.describe();
  stopwatchLaps = stopwatchLapsReader.describe();
  constructor(location = clockLocation) {
    super();
    this.#store = new ClockStore(location);
    this.identity = `apple-clock:${JSON.stringify([location.database, location.cities, location.stopwatches])}`;
  }
  open(streams) {
    return this.#store.open(new Set(streams.map((stream) => readerOf(stream).store)));
  }
  failureType(error) {
    return error instanceof ClockUnavailableError ? "config" : "system";
  }
  coverage() {
    return localAppleStoreCoverage;
  }
  async *extract(configuration, state, _partition, snapshot) {
    const records = readerOf(configuration.stream).read(snapshot);
    yield* configuration.syncMode === "incremental" ? diffSnapshot(configuration.stream, records, state) : records.map((data) => ({ stream: configuration.stream.name, data }));
  }
  async *observe({ streams, signal }) {
    var _stack = [];
    try {
      if (signal.aborted)
        return;
      const resources = __using(_stack, new DisposableStack());
      const probes = /* @__PURE__ */ new Map();
      const seen = /* @__PURE__ */ new Map();
      for (const stream of streams) {
        const store = readerOf(stream).store;
        if (probes.has(store))
          continue;
        const probe = resources.use(this.#store.version(store));
        probes.set(store, probe);
        seen.set(store, await probe.current());
      }
      yield streams;
      try {
        for await (const _2 of setInterval(1e3, void 0, { signal })) {
          const changed = /* @__PURE__ */ new Set();
          for (const [store, probe] of probes) {
            const version = await probe.current();
            if (version === seen.get(store))
              continue;
            seen.set(store, version);
            changed.add(store);
          }
          if (changed.size)
            yield streams.filter((stream) => changed.has(readerOf(stream).store));
        }
      } catch (error) {
        if (!(signal.aborted && error instanceof Error && error.name === "AbortError"))
          throw error;
      }
    } catch (_) {
      var _error = _, _hasError = true;
    } finally {
      __callDispose(_stack, _error, _hasError);
    }
  }
};

// packages/connectors/apple/clock/dist/clock-connector.js
var ClockConnector = class extends AppleConnector {
  datedBy = null;
  fullDiskAccess = true;
  choices = [];
  probe = "alarms";
  unscoped = [];
  storeCopies = [];
  access() {
    return "Open Clock once to create its stores. Clock need not stay open: this imports saved alarms, timers, world clocks and the current stopwatch with its laps.";
  }
  source() {
    return new AppleClockSource();
  }
};
export {
  ClockConnector as default
};
