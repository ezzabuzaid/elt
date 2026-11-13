import type { Outcome, Rule } from './rule.ts';
import type { Reading, Warehouse } from './warehouse.ts';

/**
 * The time of an evaluation. A host gives `globalThis`; a test can give a
 * clock it moves.
 */
export type Clock = {
  readonly Temporal: { readonly Now: { instant(): Temporal.Instant } };
};

// Where a rule is: the position its last evaluation read, and the time that
// evaluation stood for.
type Cursor = { readonly position: string; readonly at: Temporal.Instant };

// A reading that the walk holds open until it disposes it.
type Open<Sql> = Reading<Sql> & (AsyncDisposable | Disposable);

/**
 * Evaluates rules over the warehouse. It keeps nothing: each rule's cursor is
 * the host's, which gives it to each evaluation and saves the one it gets
 * back. A rule the host does not give is not evaluated, so a host removes,
 * pauses and resumes a rule by what it keeps.
 */
export class Eca<Sql, Data> {
  readonly #warehouse: Warehouse<Sql>;
  readonly #clock: Clock;

  constructor({
    warehouse,
    clock,
  }: {
    readonly warehouse: Warehouse<Sql>;
    readonly clock: Clock;
  }) {
    this.#warehouse = warehouse;
    this.#clock = clock;
  }

  /**
   * The cursor of a new rule: the newest position, now. The rule matches only
   * what becomes true after it. A warehouse with no position yet throws: load
   * it first.
   */
  async start(): Promise<string> {
    const reading = await this.#warehouse.read();
    if ('expired' in reading) throw new Error(reading.expired);
    await using _reading = reading;
    return encode({
      position: reading.position,
      at: this.#clock.Temporal.Now.instant(),
    });
  }

  /**
   * One outcome for each rule, in order. Each rule walks from its cursor over
   * each position after it, and in each step its condition evaluates two
   * readings in which one thing moved: time, with the data as it was, up to
   * the commit of the next position; then the data, at that time; and last,
   * time up to now. So a key that stops matching and matches again between
   * two evaluations matches again, and a time that passes is read with the
   * data current then. Every rule of one call ends at the same time.
   */
  async *evaluate(
    rules: Iterable<{
      readonly rule: Rule<Sql, Data>;
      readonly cursor: string;
    }>,
  ): AsyncGenerator<Outcome<Sql, Data>> {
    const now = this.#clock.Temporal.Now.instant();
    for (const { rule, cursor } of rules)
      yield await this.#walk(rule, decode(cursor), now);
  }

  // At most two readings are open: a step's before and its after. The before
  // closes once its step has evaluated, so a long pause holds no more.
  async #walk(
    rule: Rule<Sql, Data>,
    from: Cursor,
    now: Temporal.Instant,
  ): Promise<Outcome<Sql, Data>> {
    const positions = await this.#warehouse.stable(from.position);
    if ('expired' in positions) return { rule, expired: positions.expired };
    const opened = await this.#warehouse.read(from.position);
    if ('expired' in opened) return { rule, expired: opened.expired };
    let held: Open<Sql> = opened;
    let before: Reading<Sql> = { sql: opened.sql, ...from };
    const matches: Data[] = [];
    // Evaluates one step, or gives the outcome of its failure: the cursor
    // stays after the last step that evaluated.
    const step = async (after: Reading<Sql>) => {
      try {
        matches.push(...(await rule.condition.evaluate(before, after)));
      } catch (error) {
        return { rule, matches, error, cursor: encode(before) };
      }
      before = after;
      return undefined;
    };
    // A step in which time does not move changes nothing.
    const until = (at: Temporal.Instant) =>
      Temporal.Instant.compare(at, before.at) > 0
        ? step({ ...before, at })
        : undefined;
    try {
      for (const position of positions) {
        const reading = await this.#warehouse.read(position);
        if ('expired' in reading) return { rule, expired: reading.expired };
        try {
          const at = latest(reading.at, before.at, now);
          const failed =
            (await until(at)) ??
            (await step({ sql: reading.sql, position, at }));
          if (failed !== undefined) return failed;
        } finally {
          await dispose(held);
          held = reading;
        }
      }
      return (await until(now)) ?? { rule, matches, cursor: encode(before) };
    } finally {
      await dispose(held);
    }
  }
}

async function dispose(resource: AsyncDisposable | Disposable): Promise<void> {
  if (Symbol.asyncDispose in resource) await resource[Symbol.asyncDispose]();
  else resource[Symbol.dispose]();
}

// The commit time of a position, kept within the walk: never before the step
// it follows, as a position can become stable after an evaluation that came
// later than its commit, and never past the evaluation's time.
function latest(
  at: Temporal.Instant,
  floor: Temporal.Instant,
  ceiling: Temporal.Instant,
): Temporal.Instant {
  if (Temporal.Instant.compare(at, floor) < 0) return floor;
  if (Temporal.Instant.compare(at, ceiling) > 0) return ceiling;
  return at;
}

function encode({ position, at }: Cursor): string {
  return JSON.stringify({ position, at: at.toString() });
}

function decode(cursor: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor);
  } catch {
    parsed = undefined;
  }
  const position: unknown = Reflect.get(Object(parsed), 'position');
  const at: unknown = Reflect.get(Object(parsed), 'at');
  if (typeof position !== 'string' || typeof at !== 'string')
    throw new TypeError(`${cursor} is not a cursor that eca made`);
  return { position, at: Temporal.Instant.from(at) };
}
