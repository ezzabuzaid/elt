// Column schemas and the conversions every Google Health stream shares.

export const fields = {
  text: { type: ['string', 'null'] },
  number: { type: ['number', 'null'] },
  integer: { type: ['integer', 'null'] },
  boolean: { type: ['boolean', 'null'] },
  // Google sends 64-bit integers as text.
  int64: { type: ['string', 'null'], format: 'int64' },
  // A measured point's instants carry at most microseconds (Apple Health,
  // Fitbit; every point, live 2026-10-15), so they load as TIMESTAMPTZ.
  instant: { type: ['string', 'null'], format: 'date-time', precision: 6 },
  // A session an app wrote (an exercise, a sleep, a log) can carry
  // nanoseconds (one exercise did, live 2026-10-15), so its instants keep
  // nine digits, which Postgres stores as text.
  sessionInstant: {
    type: ['string', 'null'],
    format: 'date-time',
    precision: 9,
  },
  // The wall-clock time where the user was, as Google computed it.
  localTime: {
    type: ['string', 'null'],
    format: 'date-time-local',
    precision: 6,
  },
  date: { type: ['string', 'null'], format: 'date' },
  texts: { type: 'array', items: { type: 'string' } },
  integers: { type: 'array', items: { type: 'integer' } },
} as const;

const INSTANT = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/;

/**
 * A Google timestamp, RFC 3339 in UTC with zero to nine fraction digits
 * (`2026-10-13T18:19:40.024575Z`, `2026-10-03T14:33:00Z`), spelled with
 * `digits` of them. A digit past those that is not zero would be lost, so it
 * fails the read.
 */
function spelled(value: string | undefined, digits: 6 | 9): string | null {
  if (value === undefined) return null;
  const match = INSTANT.exec(value);
  const fraction = (match?.[2] ?? '').padEnd(9, '0');
  if (!match || /[^0]/.test(fraction.slice(digits)))
    throw new TypeError(
      `Google Health sent an instant finer than ${digits} fraction digits, or one it does not document: ${value}`,
    );
  return `${match[1]}.${fraction.slice(0, digits)}Z`;
}

/** A measured point's instant, to the microsecond. */
export function instant(value: string | undefined): string | null {
  return spelled(value, 6);
}

/** A session's instant, to the nanosecond. */
export function sessionInstant(value: string | undefined): string | null {
  return spelled(value, 9);
}

/**
 * A number, or null when Google sent none or one that is not finite: it sends
 * NaN for a value it could not compute, such as a sleep temperature baseline
 * before enough nights (live 2026-10-15).
 */
export function finite(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) ? value : null;
}

/** A Google duration (`10800s`, `1.5s`) as seconds. */
export function seconds(value: string | undefined): number | null {
  if (value === undefined) return null;
  const match = /^(-?\d+(?:\.\d{1,9})?)s$/.exec(value);
  if (!match)
    throw new TypeError(
      `Google Health sent a duration it does not document: ${value}`,
    );
  return Number(match[1]);
}

type CalendarDate = {
  readonly year?: number;
  readonly month?: number;
  readonly day?: number;
};

type CivilDateTime = {
  readonly date?: CalendarDate;
  readonly time?: {
    readonly hours?: number;
    readonly minutes?: number;
    readonly seconds?: number;
    readonly nanos?: number;
  };
};

const two = (value: number | undefined) => String(value ?? 0).padStart(2, '0');

/** A calendar date, or null when Google sent none or only part of one. */
export function calendarDate(value: CalendarDate | undefined): string | null {
  if (!value?.year || !value.month || !value.day) return null;
  return `${String(value.year).padStart(4, '0')}-${two(value.month)}-${two(value.day)}`;
}

/**
 * A civil date and time to the microsecond; proto3 omits a zero hour,
 * minute, second or nanosecond.
 */
function localTime(value: CivilDateTime | undefined): string | null {
  const date = calendarDate(value?.date);
  if (date === null) return null;
  const time = value?.time;
  const nanos = time?.nanos ?? 0;
  if (nanos % 1000 !== 0)
    throw new TypeError(
      `Google Health sent a civil time finer than a microsecond: ${nanos} ns`,
    );
  return `${date}T${two(time?.hours)}:${two(time?.minutes)}:${two(time?.seconds)}.${String(nanos / 1000).padStart(6, '0')}`;
}

type TimeInterval = {
  readonly startTime?: string;
  readonly startUtcOffset?: string;
  readonly endTime?: string;
  readonly endUtcOffset?: string;
  readonly civilStartTime?: CivilDateTime;
  readonly civilEndTime?: CivilDateTime;
};

function span(precise: boolean) {
  const at = precise ? fields.sessionInstant : fields.instant;
  const spell = precise ? sessionInstant : instant;
  return {
    properties: {
      startTime: { ...at, description: 'When the span began.' },
      startUtcOffsetSeconds: {
        ...fields.integer,
        description:
          "The user's offset from UTC, in seconds, when the span began.",
      },
      endTime: { ...at, description: 'When the span ended.' },
      endUtcOffsetSeconds: {
        ...fields.integer,
        description:
          "The user's offset from UTC, in seconds, when the span ended.",
      },
      civilStartTime: {
        ...fields.localTime,
        description:
          "The span's start in the user's local time, as Google computed it.",
      },
      civilEndTime: {
        ...fields.localTime,
        description:
          "The span's end in the user's local time, as Google computed it.",
      },
    },
    row(value: TimeInterval | undefined) {
      return {
        startTime: spell(value?.startTime),
        startUtcOffsetSeconds: seconds(value?.startUtcOffset),
        endTime: spell(value?.endTime),
        endUtcOffsetSeconds: seconds(value?.endUtcOffset),
        civilStartTime: localTime(value?.civilStartTime),
        civilEndTime: localTime(value?.civilEndTime),
      };
    },
  } as const;
}

/** The span a measured interval covers, to the microsecond. */
export const interval = span(false);

/** The span of a session an app wrote, to the nanosecond. */
export const session = span(true);

type SampleTime = {
  readonly physicalTime?: string;
  readonly utcOffset?: string;
  readonly civilTime?: CivilDateTime;
};

function taken(precise: boolean) {
  const at = precise ? fields.sessionInstant : fields.instant;
  const spell = precise ? sessionInstant : instant;
  return {
    properties: {
      sampleTime: { ...at, description: 'When the sample was taken.' },
      sampleUtcOffsetSeconds: {
        ...fields.integer,
        description:
          "The user's offset from UTC, in seconds, when the sample was taken.",
      },
      civilSampleTime: {
        ...fields.localTime,
        description:
          "When the sample was taken, in the user's local time, as Google computed it.",
      },
    },
    row(value: SampleTime | undefined) {
      return {
        sampleTime: spell(value?.physicalTime),
        sampleUtcOffsetSeconds: seconds(value?.utcOffset),
        civilSampleTime: localTime(value?.civilTime),
      };
    },
  } as const;
}

/** The instant a measured sample was taken, to the microsecond. */
export const sample = taken(false);

/** The instant a sample inside a session was taken, to the nanosecond. */
export const sessionSample = taken(true);

/** The calendar day a daily point summarizes. */
export const day = {
  properties: {
    date: {
      ...fields.date,
      description: "The calendar day, in the user's time zone.",
    },
  },
  row(value: CalendarDate | undefined) {
    return { date: calendarDate(value) };
  },
} as const;
