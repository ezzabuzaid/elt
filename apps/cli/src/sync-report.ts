import { intro, log, outro, type SpinnerResult, spinner } from '@clack/prompts';
import type { CopyProgress } from 'elt';
import type { SQLiteTable } from 'elt-sqlite';
import type { AppleApp } from './apps/apple-app.ts';
import type { PassSummary, SyncObserver } from './sync.ts';
import { json } from './table.ts';

const count = new Intl.NumberFormat('en');

// Shows a sync as it runs: one spinner naming every stream still reading with
// what it has read so far, a line per app as each pass ends, and while
// watching, a spinner waiting for the next change. Without a terminal, one
// JSON line per pass.
export class SyncReport implements SyncObserver {
  readonly #reading = new Map<string, string>();
  #spinner: SpinnerResult | undefined;
  #shownAt = 0;
  #incomplete = false;

  constructor(
    readonly interactive: boolean,
    readonly watching: boolean,
  ) {}

  // Exit status 1 once any pass did not load completely.
  get exitCode(): number {
    return this.#incomplete ? 1 : 0;
  }

  start(): void {
    if (!this.interactive) return;
    intro('Apple sync');
    this.#spin();
  }

  progress(
    app: AppleApp,
    { copy, status, emitted }: CopyProgress<SQLiteTable>,
  ) {
    if (!this.interactive) return;
    const key = `${app.name}:${copy.from.name}`;
    if (status === 'running')
      this.#reading.set(
        key,
        `${app.title} ${copy.from.name} ${count.format(emitted.count + emitted.deleted)}`,
      );
    else this.#reading.delete(key);
    if (performance.now() - this.#shownAt > 100) this.#show();
  }

  passed({ title }: AppleApp, summary: PassSummary): void {
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
    if (this.#reading.size > 0 || this.watching) this.#spin();
  }

  finish(): void {
    if (!this.interactive) return;
    this.#spinner?.clear();
    outro(this.#closing());
  }

  #closing(): string {
    if (this.watching) return 'Stopped watching.';
    if (this.#incomplete) return 'Some apps did not load completely.';
    return 'All apps current.';
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
    return (
      [...this.#reading.values()].join(' · ') ||
      (this.watching ? 'Watching for changes' : 'Reading')
    );
  }
}
