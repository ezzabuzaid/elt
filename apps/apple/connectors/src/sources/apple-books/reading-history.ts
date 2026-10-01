import { BooksSchemaError } from '../../platform/macos/books-store.ts';
import { ProtobufMessage } from '../../platform/macos/protobuf.ts';

// Books' reading history is a Coherence CRDT document (Apple's private CRDT
// framework, wire format version 4) that bookdatastored syncs through
// CloudKit. Its root struct holds two dictionaries:
//   months: yyyymm -> reference to a month object
//     month: { totalTime?, lastDayStreakOrdinal, days: day of month -> reference to a day object }
//     day:   { readingTime: counter, readingGoal }
//   streakRecords: streak length in days -> the date it was reached
// Books summarizes old months into totalTime and prunes their days.

export type ReadingMonth = {
  readonly year: number;
  readonly month: number;
  readonly totalTime: number | null;
  readonly lastDayStreakOrdinal: number | null;
  readonly dayCount: number;
};
export type ReadingDay = {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly readingTime: number;
  readonly readingGoal: number | null;
};
export type StreakRecord = { readonly days: number; readonly reachedAt: Date };
export type ReadingHistory = {
  readonly months: readonly ReadingMonth[];
  readonly days: readonly ReadingDay[];
  readonly streaks: readonly StreakRecord[];
};

const magic = 'crdt';
const supportedVersion = 4;

class Layout {
  readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  fail(what: string): never {
    throw new BooksSchemaError(this.source, [`reading history ${what}`]);
  }

  need<T>(value: T | undefined, what: string): T {
    return value === undefined ? this.fail(what) : value;
  }
}

// A struct CRDT's named fields.
function fields(
  crdt: ProtobufMessage,
  layout: Layout,
): Map<string, ProtobufMessage> {
  const struct = layout.need(crdt.message(4), 'struct');
  return new Map(
    struct
      .messages(1)
      .map((field) => [
        layout.need(field.string(1), 'struct field name'),
        layout.need(field.message(2), 'struct field value'),
      ]),
  );
}

// A last-writer-wins register's current value.
const registerValue = (crdt: ProtobufMessage, layout: Layout) =>
  layout.need(
    layout.need(crdt.message(1), 'register').message(3),
    'register value',
  );

const integer = (value: ProtobufMessage, layout: Layout) =>
  layout.need(value.int(1), 'integer value');

const reference = (value: ProtobufMessage, layout: Layout) =>
  Buffer.from(
    layout.need(
      layout.need(value.message(6), 'reference').bytes(1),
      'reference id',
    ),
  ).toString('hex');

// A dictionary CRDT keyed by integers, each value a register.
function dictionary(
  crdt: ProtobufMessage,
  layout: Layout,
): [number, ProtobufMessage][] {
  const map = layout.need(crdt.message(3), 'dictionary');
  return map
    .messages(3)
    .map((entry) => [
      integer(layout.need(entry.message(1), 'dictionary key'), layout),
      registerValue(layout.need(entry.message(2), 'dictionary value'), layout),
    ]);
}

// A counter CRDT: each replica keeps how much it decremented and incremented,
// as packed varints.
function counter(crdt: ProtobufMessage, layout: Layout): number {
  const value = layout.need(crdt.message(7), 'counter');
  let total = 0;
  for (const replicas of value.messages(2))
    for (const replica of replicas.messages(1)) {
      const parts = varints(layout.need(replica.bytes(2), 'counter value'));
      if (parts.length !== 2) layout.fail('counter value');
      const [decrements, increments] = parts as [number, number];
      total += increments - decrements;
    }
  return total;
}

function varints(bytes: Uint8Array): number[] {
  const values: number[] = [];
  let value = 0n;
  let shift = 0n;
  for (const byte of bytes) {
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      values.push(Number(value));
      value = 0n;
      shift = 0n;
    } else shift += 7n;
  }
  return values;
}

export function readingHistory(
  bytes: Uint8Array,
  source: string,
): ReadingHistory {
  const layout = new Layout(source);
  if (
    bytes.length < 8 ||
    Buffer.from(bytes.subarray(0, 4)).toString('latin1') !== magic
  )
    layout.fail('signature');
  const version = Buffer.from(bytes.subarray(4, 8)).readUInt32LE(0);
  if (version !== supportedVersion) layout.fail(`format version ${version}`);
  const document = new ProtobufMessage(bytes.subarray(8));
  const objects = new Map(
    document
      .messages(2)
      .map((object) => [
        Buffer.from(layout.need(object.bytes(1), 'object id')).toString('hex'),
        layout.need(object.message(3), 'object value'),
      ]),
  );
  const object = (id: string) => layout.need(objects.get(id), 'object');
  const root = fields(layout.need(document.message(1), 'root'), layout);
  const months: ReadingMonth[] = [];
  const days: ReadingDay[] = [];
  for (const [key, value] of dictionary(
    layout.need(root.get('months'), 'months'),
    layout,
  )) {
    const year = Math.trunc(key / 100);
    const month = key % 100;
    if (month < 1 || month > 12) layout.fail(`month key ${key}`);
    const monthFields = fields(object(reference(value, layout)), layout);
    const total = monthFields.get('totalTime');
    const streak = monthFields.get('lastDayStreakOrdinal');
    const monthDays = dictionary(
      layout.need(monthFields.get('days'), 'month days'),
      layout,
    );
    months.push({
      year,
      month,
      totalTime:
        total === undefined
          ? null
          : integer(registerValue(total, layout), layout),
      lastDayStreakOrdinal:
        streak === undefined
          ? null
          : integer(registerValue(streak, layout), layout),
      dayCount: monthDays.length,
    });
    for (const [day, dayValue] of monthDays) {
      const dayFields = fields(object(reference(dayValue, layout)), layout);
      const goal = dayFields.get('readingGoal');
      days.push({
        year,
        month,
        day,
        readingTime: counter(
          layout.need(dayFields.get('readingTime'), 'readingTime'),
          layout,
        ),
        readingGoal:
          goal === undefined
            ? null
            : integer(registerValue(goal, layout), layout),
      });
    }
  }
  const streaks = dictionary(
    layout.need(root.get('streakRecords'), 'streakRecords'),
    layout,
  ).map(([days, value]) => ({
    days,
    reachedAt: new Date(
      layout.need(
        layout.need(value.message(5), 'date').int(1),
        'date seconds',
      ) * 1000,
    ),
  }));
  return { months, days, streaks };
}
