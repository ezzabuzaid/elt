import { type SpinnerResult, intro, log, outro, spinner } from '@clack/prompts';

import type { AppleConnector } from '@workspace/connector-apple-connector/apple-connector';
import type { CopyProgress } from '@workspace/elt';
import type { SQLiteTable } from '@workspace/elt-sqlite';

import type { SyncObserver } from './imports.ts';
import type { PassSummary } from './sync.ts';
import { json } from './table.ts';

const count = new Intl.NumberFormat('en');

// Shows a sync as it runs: one spinner naming every stream still reading with
// what it has read so far and a line per connector as each pass ends or is
// skipped. Without a terminal, one JSON line per pass or skipped import.
export class SyncReport implements SyncObserver {
  readonly interactive: boolean;
  readonly #reading = new Map<string, string>();
  #spinner: SpinnerResult | undefined;
  #shownAt = 0;
  #incomplete = false;

  constructor(interactive: boolean) {
    this.interactive = interactive;
  }

  start(): void {
    if (!this.interactive) return;
    intro('Apple sync');
    this.#spin();
  }

  progress(
    connector: AppleConnector,
    { copy, status, emitted }: CopyProgress<SQLiteTable>,
  ) {
    if (!this.interactive) return;
    const key = `${connector.name}:${copy.from.name}`;
    if (status === 'running')
      this.#reading.set(
        key,
        `${connector.title} ${copy.from.name} ${count.format(emitted.count + emitted.deleted)}`,
      );
    else this.#reading.delete(key);
    if (performance.now() - this.#shownAt > 100) this.#show();
  }

  passed({ title }: AppleConnector, summary: PassSummary): void {
    // A cancelled pass is a removed connector; skipped reports it.
    if (summary.status === 'cancelled') return;
    if (summary.status !== 'succeeded') this.#incomplete = true;
    if (!this.interactive) {
      process.stdout.write(`${json(summary, 0)}\n`);
      return;
    }
    this.#spinner?.clear();
    this.#spinner = undefined;
    const written = summary.streams.reduce(
      (total, { written, deleted }) => total + written + deleted,
      0,
    );
    const line = `${title.padEnd(10)} ${written === 0 ? 'no changes' : `${count.format(written)} rows`} · ${summary.streams.length} streams · ${summary.seconds}s`;
    if (summary.status === 'succeeded') log.success(line);
    else log.warn(`${title.padEnd(10)} ${summary.status} · ${summary.error}`);
    if (this.#reading.size > 0) this.#spin();
  }

  skipped({ name, title }: AppleConnector, why: 'busy' | 'removed'): void {
    if (why === 'busy') this.#incomplete = true;
    if (!this.interactive) {
      process.stdout.write(`${json({ connector: name, status: why }, 0)}\n`);
      return;
    }
    this.#spinner?.clear();
    this.#spinner = undefined;
    if (why === 'busy')
      log.warn(`${title.padEnd(10)} skipped · another sync is importing it`);
    else
      log.info(
        `${title.padEnd(10)} stopped · removed from the selection by another setup`,
      );
    if (this.#reading.size > 0) this.#spin();
  }

  finish(): void {
    if (!this.interactive) return;
    this.#spinner?.clear();
    outro(
      this.#incomplete
        ? 'Some connectors did not load completely.'
        : 'All connectors current.',
    );
  }

  // Cancelling the spinner hands the terminal back: the cursor shows again and
  // keys echo.
  interrupted(): void {
    this.#spinner?.cancel('Sync interrupted');
  }

  // Without its guide, a spinner leaves no bar behind when cleared, so each
  // pass's line follows the last.
  #spin(): SpinnerResult {
    this.#spinner = spinner({ withGuide: false });
    this.#spinner.start(this.#status());
    return this.#spinner;
  }

  #show(): void {
    this.#shownAt = performance.now();
    (this.#spinner ?? this.#spin()).message(this.#status());
  }

  #status(): string {
    return [...this.#reading.values()].join(' · ') || 'Reading';
  }
}
