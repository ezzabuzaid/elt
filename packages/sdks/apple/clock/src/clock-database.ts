import {
  AppDatabase,
  type AppDatabaseColumns,
} from '@workspace/sdk-apple-app-database';

import { ClockSchemaError, ClockUnavailableError } from './errors.ts';
import {
  bytes,
  flag,
  instant,
  number,
  requiredText,
  text,
  timerTime,
  uuid,
} from './values.ts';

const columns = {
  ZMTCDALARM: [
    'ZMTID',
    'ZTITLE',
    'ZENABLED',
    'ZHOUR',
    'ZMINUTE',
    'ZDAY',
    'ZMONTH',
    'ZYEAR',
    'ZREPEATSCHEDULE',
    'ZALLOWSSNOOZE',
    'ZSNOOZEDURATION',
    'ZSLEEPALARM',
    'ZSLEEPSCHEDULE',
    'ZSILENTMODEOPTIONS',
    'ZCOORDINATIONPOLICY',
    'ZDISMISSEDACTION',
    'ZDISMISSEDDATE',
    'ZFIREDDATE',
    'ZKEEPOFFUNTILDATE',
    'ZLASTMODIFIEDDATE',
    'ZSNOOZEFIREDATE',
    'ZSOUND',
    'ZSIRICONTEXT',
  ],
  ZMTCDTIMER: [
    'ZMTID',
    'ZTITLE',
    'ZSTATE',
    'ZDURATION',
    'ZSOUND',
    'ZDISMISSEDDATE',
    'ZFIREDDATE',
    'ZLASTMODIFIEDDATE',
    'ZTIMERURL',
    'ZSIRICONTEXT',
    'ZTIMERCONTEXT',
    'ZFIRETIME',
  ],
  ZMTCDTIMERDURATION: [
    'Z_PK',
    'ZTITLE',
    'ZDURATION',
    'ZISFAVORITE',
    'ZLATEST',
    'ZVALIDRECENT',
    'ZLASTMODIFIED',
    'ZSOUND',
  ],
  ZMTCDSOUND: [
    'Z_PK',
    'ZSOUNDTYPE',
    'ZVOLUMELEVEL',
    'ZTONEIDENTIFIER',
    'ZVIBRATIONIDENTIFIER',
    'ZMEDIAITEMIDENTIFIER',
  ],
  ZMTCDCALENDARRELEASE: [
    'Z_PK',
    'ZREGION',
    'ZYEAR',
    'ZRELEASEDATE',
    'ZLASTCHECKEDDATE',
  ],
  ZMTCDMAKEUPDAY: ['Z_PK', 'ZDATE', 'ZTYPE', 'ZCALENDARRELEASE'],
  ZMTCDREPORT: ['Z_PK', 'ZDATE', 'ZCONCERNS'],
} satisfies AppDatabaseColumns;

// One read-only transaction pins all related Clock entities to the same commit.
export class ClockDatabase implements Disposable {
  readonly #database: AppDatabase;
  constructor(path: string) {
    this.#database = new AppDatabase(path, ClockUnavailableError);
    this.#database.requireColumns(columns, ClockSchemaError);
  }

  alarms() {
    return this.#database
      .all(
        `SELECT ZMTID AS "id", ZTITLE AS "title", ZENABLED AS "enabled", ZHOUR AS "hour", ZMINUTE AS "minute", ZDAY AS "day", ZMONTH AS "month", ZYEAR AS "year", ZREPEATSCHEDULE AS "repeatSchedule", ZALLOWSSNOOZE AS "allowsSnooze", ZSNOOZEDURATION AS "snoozeMinutes", ZSLEEPALARM AS "sleepAlarm", ZSLEEPSCHEDULE AS "sleepSchedule", ZSILENTMODEOPTIONS AS "silentModeOptions", ZCOORDINATIONPOLICY AS "coordinationPolicy", ZDISMISSEDACTION AS "dismissedAction", ZDISMISSEDDATE AS "dismissedAt", ZFIREDDATE AS "firedAt", ZKEEPOFFUNTILDATE AS "keepOffUntil", ZLASTMODIFIEDDATE AS "modifiedAt", ZSNOOZEFIREDATE AS "snoozeFireAt", CAST(ZSOUND AS TEXT) AS "soundId", ZSIRICONTEXT AS "siriContext" FROM ZMTCDALARM ORDER BY Z_PK`,
      )
      .map((row) => ({
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
        siriContext: bytes(row.siriContext),
      }));
  }

  timers() {
    return this.#database
      .all(
        `SELECT ZMTID AS "id", ZTITLE AS "title", ZSTATE AS "stateCode", ZDURATION AS "duration", CAST(ZSOUND AS TEXT) AS "soundId", ZDISMISSEDDATE AS "dismissedAt", ZFIREDDATE AS "firedAt", ZLASTMODIFIEDDATE AS "modifiedAt", ZTIMERURL AS "url", ZSIRICONTEXT AS "siriContext", ZTIMERCONTEXT AS "timerContext", ZFIRETIME AS fireTime FROM ZMTCDTIMER ORDER BY Z_PK`,
      )
      .map((row) => ({
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
        ...timerTime(row.fireTime),
      }));
  }

  timerDurations() {
    return this.#database
      .all(
        `SELECT CAST(Z_PK AS TEXT) AS "id", ZTITLE AS "title", ZDURATION AS "duration", ZISFAVORITE AS "favorite", ZLATEST AS "latest", ZVALIDRECENT AS "validRecent", ZLASTMODIFIED AS "modifiedAt", CAST(ZSOUND AS TEXT) AS "soundId" FROM ZMTCDTIMERDURATION ORDER BY Z_PK`,
      )
      .map((row) => ({
        id: requiredText(row.id),
        title: text(row.title),
        duration: number(row.duration),
        favorite: flag(row.favorite),
        latest: flag(row.latest),
        validRecent: flag(row.validRecent),
        modifiedAt: instant(row.modifiedAt),
        soundId: text(row.soundId),
      }));
  }

  sounds() {
    return this.#database
      .all(
        `SELECT CAST(Z_PK AS TEXT) AS "id", ZSOUNDTYPE AS "typeCode", ZVOLUMELEVEL AS "volume", ZTONEIDENTIFIER AS "toneId", ZVIBRATIONIDENTIFIER AS "vibrationId", CAST(ZMEDIAITEMIDENTIFIER AS TEXT) AS "mediaItemId" FROM ZMTCDSOUND ORDER BY Z_PK`,
      )
      .map((row) => ({
        id: requiredText(row.id),
        typeCode: number(row.typeCode),
        volume: number(row.volume),
        toneId: text(row.toneId),
        vibrationId: text(row.vibrationId),
        mediaItemId: text(row.mediaItemId),
      }));
  }

  calendarReleases() {
    return this.#database
      .all(
        `SELECT CAST(Z_PK AS TEXT) AS "id", ZREGION AS "region", ZYEAR AS "year", ZRELEASEDATE AS "releasedAt", ZLASTCHECKEDDATE AS "checkedAt" FROM ZMTCDCALENDARRELEASE ORDER BY Z_PK`,
      )
      .map((row) => ({
        id: requiredText(row.id),
        region: text(row.region),
        year: text(row.year),
        releasedAt: instant(row.releasedAt),
        checkedAt: instant(row.checkedAt),
      }));
  }

  makeupDays() {
    return this.#database
      .all(
        `SELECT CAST(Z_PK AS TEXT) AS "id", ZDATE AS "date", ZTYPE AS "typeCode", CAST(ZCALENDARRELEASE AS TEXT) AS "calendarReleaseId" FROM ZMTCDMAKEUPDAY ORDER BY Z_PK`,
      )
      .map((row) => ({
        id: requiredText(row.id),
        date: instant(row.date),
        typeCode: number(row.typeCode),
        calendarReleaseId: text(row.calendarReleaseId),
      }));
  }

  reports() {
    return this.#database
      .all(
        `SELECT CAST(Z_PK AS TEXT) AS "id", ZDATE AS "date", ZCONCERNS AS "concerns" FROM ZMTCDREPORT ORDER BY Z_PK`,
      )
      .map((row) => ({
        id: requiredText(row.id),
        date: instant(row.date),
        concerns: number(row.concerns),
      }));
  }

  [Symbol.dispose](): void {
    this.#database[Symbol.dispose]();
  }
}
