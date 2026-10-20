import { type SpinnerResult, intro, log, outro, spinner } from '@clack/prompts';

import type { AppleConnector } from '@workspace/connector-apple-connector/apple-connector';
import type { CopyProgress } from '@workspace/elt';
import type { SQLiteTable } from '@workspace/elt-sqlite';

import type { SyncObserver } from './imports.ts';
import type { PassSummary } from './sync.ts';
import { counted, json } from './table.ts';

const count = new Intl.NumberFormat('en');

// Shows a sync as it runs: one spinner naming every stream still reading with
// what it has read so far, a line per connector whose pass another sync runs,
// and a line per connector as each pass ends or is skipped. Without a
// terminal, one JSON line per pass or skipped import.
export class SyncReport implements SyncObserver {
  readonly interactive: boolean;
  // What the spinner says while no stream reads.
  protected readonly idle: string = 'Reading';
  // Whether the spinner comes back between passes, while no stream reads.
  protected readonly spinsWhenIdle: boolean = false;
  protected readonly interruption: string = 'Sync interrupted';
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
    this.line(summary, () => {
      const written = summary.streams.reduce(
        (total, { written, deleted }) => total + written + deleted,
        0,
      );
      const line = `${title.padEnd(10)} ${written === 0 ? 'no changes' : counted(written, 'row')} · ${counted(summary.streams.length, 'stream')} · ${summary.seconds}s`;
      if (summary.status === 'succeeded') log.success(line);
      else log.warn(`${title.padEnd(10)} ${summary.status} · ${summary.error}`);
    });
  }

  // The spinner comes back after the line, so a sync that only waits still
  // shows it runs, and Ctrl-C stops it the same way.
  joined({ title }: AppleConnector): void {
    if (!this.interactive) return;
    this.#spinner?.clear();
    log.info(`${title.padEnd(10)} a sync is importing it · waiting…`);
    this.#spin();
  }

  skipped(
    { name, title }: AppleConnector,
    why: 'removed' | 'interrupted' | 'watched',
  ): void {
    if (why === 'interrupted') this.#incomplete = true;
    this.line({ connector: name, status: why }, () => {
      if (why === 'interrupted')
        log.warn(
          `${title.padEnd(10)} interrupted · the sync importing it stopped`,
        );
      else if (why === 'watched')
        log.info(`${title.padEnd(10)} kept current by apple-cli sync watch`);
      else
        log.info(
          `${title.padEnd(10)} stopped · removed from the selection by another setup`,
        );
    });
  }

  finish(): void {
    if (!this.interactive) return;
    this.#spinner?.clear();
    outro(this.closing());
  }

  protected closing(): string {
    return this.#incomplete
      ? 'Some connectors did not load completely.'
      : 'All connectors current.';
  }

  // Cancelling the spinner hands the terminal back: the cursor shows again and
  // keys echo.
  interrupted(): void {
    this.#spinner?.cancel(this.interruption);
  }

  // One line about an import: its JSON without a terminal; otherwise shown in
  // place of the spinner, which comes back while a stream still reads.
  protected line(data: object, show: () => void): void {
    if (!this.interactive) {
      process.stdout.write(`${json(data, 0)}\n`);
      return;
    }
    this.#spinner?.clear();
    this.#spinner = undefined;
    show();
    if (this.#reading.size > 0 || this.spinsWhenIdle) this.#spin();
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
    return [...this.#reading.values()].join(' · ') || this.idle;
  }
}
