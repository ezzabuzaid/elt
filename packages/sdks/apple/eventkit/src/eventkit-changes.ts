import { Gauge, Latch } from '@zukhruf/async';

// The count of the changes that the helper of an EventKit store reported, so
// its value changes at each change. While the helper subscribes, EventKit
// posts every change, so a read with the same count found the store
// unchanged. The first read starts the helper and waits until it confirms its
// subscription; a read after the helper failed throws that failure, and the
// next read starts a new helper. A dispose stops the helper and waits for it
// to end.
export class EventKitChanges extends Gauge<number> implements AsyncDisposable {
  // The longest a read takes. A read that starts a helper waits for its
  // subscription: 8 helpers that started at one time under a load of 55
  // subscribed in at most 1.3 s (measured on 2026-11-07). When macOS has not
  // yet asked for access, the helper first waits up to 30 s for the user's
  // answer (Access.swift). Every other read is of memory.
  readonly timeout = 35_000;
  readonly #watch: (signal: AbortSignal) => AsyncIterable<void>;
  // Each confirmed subscription counts as a change too: the store could have
  // changed while no helper subscribed.
  #changes = 0;
  #state: Stopped | Running | Failed = new Stopped();

  constructor(watch: (signal: AbortSignal) => AsyncIterable<void>) {
    super();
    this.#watch = watch;
  }

  protected async read(): Promise<number> {
    const state = this.#state;
    if (state instanceof Failed) {
      this.#state = new Stopped();
      throw state.error;
    }
    const running =
      state instanceof Running
        ? state
        : new Running(
            this.#watch,
            () => this.#changes++,
            (error) => {
              this.#state = new Failed(error);
            },
          );
    this.#state = running;
    const subscription = await running.subscribed.wait();
    if (subscription.status === 'rejected') {
      // This read gives the failure, so the next read starts a new helper.
      this.#state = new Stopped();
      throw subscription.reason;
    }
    return this.#changes;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    const state = this.#state;
    this.#state = new Stopped();
    if (state instanceof Running) await state.stop();
  }
}

// No helper runs.
class Stopped {}

// A helper that failed; the next read gives its failure.
class Failed {
  readonly error: unknown;

  constructor(error: unknown) {
    this.error = error;
  }
}

// A helper that runs until it fails or is stopped.
class Running {
  // Opens when the helper confirms its subscription, or fails before it.
  readonly subscribed = new Latch<PromiseSettledResult<void>>();
  readonly #controller = new AbortController();
  readonly #ended = new Latch();

  constructor(
    watch: (signal: AbortSignal) => AsyncIterable<void>,
    changed: () => void,
    failed: (error: unknown) => void,
  ) {
    void this.#run(watch, changed, failed);
  }

  async stop(): Promise<void> {
    this.#controller.abort();
    await this.#ended.wait();
  }

  async #run(
    watch: (signal: AbortSignal) => AsyncIterable<void>,
    changed: () => void,
    failed: (error: unknown) => void,
  ): Promise<void> {
    const { signal } = this.#controller;
    try {
      for await (const _change of watch(signal)) {
        changed();
        this.subscribed.open({ status: 'fulfilled', value: undefined });
      }
    } catch (error) {
      this.subscribed.open({ status: 'rejected', reason: error });
      failed(error);
    } finally {
      this.#ended.open();
    }
  }
}
