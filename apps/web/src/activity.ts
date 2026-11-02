import { EventEmitter, on } from 'node:events';

import { passChannels } from '@workspace/elt';
import { crawlChannels } from '@workspace/sdk-web-crawler';
import { pageChannels } from '@workspace/source-web-pages/page-channels';

import type { Activity as State } from './contract.ts';
import { RunProgress } from './run-progress.ts';

// Before the first Sync since the server started.
class NoRun {
  hear(): void {}
  fail(): void {}
  snapshot(): null {
    return null;
  }
}

// The last Sync, as pages watch it. Each change publishes the version it
// made, so a page that sent a later snapshot skips it. EventEmitter keeps no
// last value, and a page that connects mid-sync needs it.
class Activity {
  #run: RunProgress | NoRun = new NoRun();
  #version = 0;
  readonly #changes = new EventEmitter<{ change: [number] }>();

  get current(): State {
    return this.#run.snapshot();
  }

  get version(): number {
    return this.#version;
  }

  start(): void {
    this.#run = new RunProgress();
    this.#changed();
  }

  hear(message: unknown): void {
    this.#run.hear(message);
    this.#changed();
  }

  fail(error: unknown): void {
    this.#run.fail(error);
    this.#changed();
  }

  // Subscribes now, so a change published before the first read is buffered.
  changes(signal: AbortSignal) {
    return on(this.#changes, 'change', { signal });
  }

  #changed(): void {
    this.#changes.emit('change', ++this.#version);
  }
}

const activity = new Activity();

// Passes run only in this process's Sync, so every message is its run's.
const hear = (message: unknown) => {
  activity.hear(message);
};
for (const channel of [
  passChannels.progress,
  passChannels.finish,
  passChannels.failure,
  crawlChannels.request,
  crawlChannels.end,
  crawlChannels.block,
  pageChannels.extract,
]) {
  channel.subscribe(hear);
}

export default activity;
