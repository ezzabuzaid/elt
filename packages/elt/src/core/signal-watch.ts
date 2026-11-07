import {
  ChangeWatcher,
  type Check,
  Gauge,
  type Outcome,
  type Value,
} from '@zukhruf/async';

import type { ChangeSignal } from './change-signal.ts';
import type { PipelineClock } from './clock.ts';
import { interleave } from './interleave.ts';
import type { FailureType } from './source.ts';
import type { Stream } from './stream.ts';

// Why a source's change signals break the contract for the selected streams,
// or undefined when they keep it: each selected stream is in one change
// signal or more, no change signal names another stream, and the change
// signals of one stream have one interval and one timeout.
export function brokenSignals(
  signals: readonly ChangeSignal[],
  selected: readonly Stream[],
): string | undefined {
  const names = new Set(selected.map(({ name }) => name));
  const paces = new Map<string, string>();
  for (const { streams, interval, timeout } of signals)
    for (const { name } of streams) {
      if (!names.has(name))
        return `A change signal names an unselected stream: ${name}`;
      const pace = `${interval}/${timeout}`;
      const known = paces.get(name);
      if (known !== undefined && known !== pace)
        return `The change signals of stream ${name} have two intervals`;
      paces.set(name, pace);
    }
  const missing = selected.find(({ name }) => !paces.has(name));
  return missing === undefined
    ? undefined
    : `No change signal tells about stream ${missing.name}`;
}

// At each check of one interval, the outcome of each stream that the check
// covered, by stream name: changed when one of its gauges changed, else
// failed when one of them failed, else unchanged. Each interval and timeout
// has its own change watcher, so a slow read is not made at each check of a
// fast one (ADR 0020).
export function watchSignals(
  signals: readonly ChangeSignal[],
  options: {
    readonly signal: AbortSignal;
    readonly clock: PipelineClock;
    readonly failureType: (error: unknown) => FailureType;
  },
): AsyncGenerator<ReadonlyMap<string, Outcome>> {
  const paces = new Map<string, Pace>();
  for (const { gauge, streams, interval, timeout } of signals) {
    const key = `${interval}/${timeout}`;
    const pace = paces.get(key) ?? { interval, timeout, gauges: new Map() };
    paces.set(key, pace);
    const read =
      pace.gauges.get(gauge) ?? new SignalGauge(gauge, options.failureType);
    pace.gauges.set(gauge, read);
    read.streams.push(...streams.map(({ name }) => name));
  }
  return interleave(
    [...paces.values()].map((pace) => watchPace(pace, options)),
    Number.POSITIVE_INFINITY,
  );
}

// The change signals of one interval and timeout, one SignalGauge for each
// gauge of the source.
type Pace = {
  readonly interval: number;
  readonly timeout: number;
  readonly gauges: Map<Gauge, SignalGauge>;
};

async function* watchPace(
  { interval, timeout, gauges }: Pace,
  {
    signal,
    clock,
  }: { readonly signal: AbortSignal; readonly clock: PipelineClock },
): AsyncGenerator<ReadonlyMap<string, Outcome>> {
  const watcher = new ChangeWatcher(gauges.values(), {
    interval,
    timeout,
    clock,
  });
  for await (const outcomes of watcher.watch(signal)) {
    const ofStream = Map.groupBy(
      [...outcomes].flatMap(([gauge, outcome]) =>
        gauge.streams.map((name) => ({ name, outcome })),
      ),
      ({ name }) => name,
    );
    yield new Map(
      [...ofStream].map(([name, told]) => [
        name,
        combined(told.map(({ outcome }) => outcome)),
      ]),
    );
  }
}

function combined(outcomes: readonly Outcome[]): Outcome {
  return (
    outcomes.find(({ state }) => state === 'changed') ??
    outcomes.find(({ state }) => state === 'failed') ?? { state: 'unchanged' }
  );
}

// A gauge of a source as the pipeline reads it: the streams that it tells
// about, in all the change signals of one interval, and no read after a
// failure that only the user can fix, as such a failure stopped the whole
// connection before: a refused login is not tried again at each check. A new
// watch reads it again (ADR 0020).
class SignalGauge extends Gauge {
  readonly streams: string[] = [];
  #state: HaltingState;

  constructor(gauge: Gauge, failureType: (error: unknown) => FailureType) {
    super();
    this.#state = new Reading(gauge, failureType);
  }

  protected async read(check: Check): Promise<Value> {
    const { result, next } = await this.#state.read(check);
    this.#state = next;
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  }
}

type HaltingRead = {
  readonly result: PromiseSettledResult<Value>;
  readonly next: HaltingState;
};

interface HaltingState {
  read(check: Check): Promise<HaltingRead>;
}

// Reads the gauge, and halts after a failure of the config type.
class Reading implements HaltingState {
  readonly #gauge: Gauge;
  readonly #failureType: (error: unknown) => FailureType;

  constructor(gauge: Gauge, failureType: (error: unknown) => FailureType) {
    this.#gauge = gauge;
    this.#failureType = failureType;
  }

  async read(check: Check): Promise<HaltingRead> {
    try {
      const value = await this.#gauge.value(check);
      return { result: { status: 'fulfilled', value }, next: this };
    } catch (reason) {
      return {
        result: { status: 'rejected', reason },
        next:
          this.#failureType(reason) === 'config' ? new Halted(reason) : this,
      };
    }
  }
}

// Gives the failure that halted it, and reads nothing.
class Halted implements HaltingState {
  readonly #reason: unknown;

  constructor(reason: unknown) {
    this.#reason = reason;
  }

  async read(): Promise<HaltingRead> {
    return { result: { status: 'rejected', reason: this.#reason }, next: this };
  }
}
