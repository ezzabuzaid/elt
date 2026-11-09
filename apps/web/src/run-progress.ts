import {
  CopyProgress,
  PassFailed,
  PassFinished,
  passError,
  passStatus,
} from '@eltjs/elt';
import {
  type Crawl,
  CrawlEnded,
  CrawlRequested,
  OriginBlocked,
} from '@eltjs/sdk-web-crawler';
import { PageExtracted } from '@eltjs/source-web-pages/page-channels';

import type { CrawlRequest, Run } from './contract.ts';

// The requests a page shows, as a log's tail: the latest ones.
const shown = 50;

// One Sync, built from what its pass, its crawls and its source publish.
export class RunProgress {
  readonly #run: Omit<Run, 'waiting' | 'held' | 'blocks' | 'nextDue'> = {
    startedAt: Date.now(),
    requests: 0,
    failed: 0,
    pages: 0,
    unchanged: 0,
    written: 0,
    log: [],
    ended: null,
  };
  // The frontier of each open crawl after its latest request. A Sync crawls
  // each site, and crawls of several sites run at once.
  readonly #frontiers = new Map<Crawl, { waiting: number; held: number }>();
  readonly #blocks = new Map<string, number>();
  // When each ended crawl is due again; null when nothing of it ever is.
  readonly #due = new Map<Crawl, number | null>();

  get running(): boolean {
    return this.#run.ended === null;
  }

  hear(message: unknown): void {
    if (message instanceof CrawlRequested) {
      this.#requested(message);
    } else if (message instanceof PageExtracted) {
      this.#extracted(message);
    } else if (message instanceof CrawlEnded) {
      this.#frontiers.delete(message.crawl);
      this.#due.set(message.crawl, message.nextDue);
    } else if (message instanceof OriginBlocked) {
      this.#blocks.set(message.origin, message.until);
    } else if (
      message instanceof CopyProgress &&
      message.copy.from.name === 'articles'
    ) {
      // The records of the articles table, which the page lists.
      this.#run.written = message.committed.count;
    } else if (message instanceof PassFinished) {
      this.#end(passStatus(message.outcomes), passError(message.outcomes));
    } else if (message instanceof PassFailed) {
      this.#end('failed', reason(message.error));
    }
  }

  // A Sync that failed before its pass, such as a discover that threw, ends
  // here; a pass that ended keeps the status it recorded.
  fail(error: unknown): void {
    if (this.running) {
      this.#end('failed', reason(error));
    }
  }

  snapshot(): Run {
    const frontiers = [...this.#frontiers.values()];
    const due = [...this.#due.values()].filter((at) => at !== null);
    return structuredClone({
      ...this.#run,
      waiting: frontiers.reduce((total, { waiting }) => total + waiting, 0),
      held: frontiers.reduce((total, { held }) => total + held, 0),
      blocks: [...this.#blocks].map(([origin, until]) => ({ origin, until })),
      nextDue: due.length === 0 ? null : Math.min(...due),
    });
  }

  #requested(message: CrawlRequested): void {
    const { outcome } = message;
    const failed = 'error' in outcome || outcome.status >= 400;
    const request: CrawlRequest = {
      id: ++this.#run.requests,
      url: message.url,
      list: message.list,
      waited: message.waited,
      failed,
      outcome:
        'error' in outcome
          ? { kind: 'errored', error: reason(outcome.error) }
          : {
              kind: 'answered',
              status: outcome.status,
              duration:
                message.served === 'origin record'
                  ? null
                  : (outcome.timings?.phases.total ?? null),
            },
      page: null,
    };
    if (failed) {
      this.#run.failed += 1;
    }
    this.#run.log.unshift(request);
    this.#run.log.splice(shown);
    this.#frontiers.set(message.crawl, {
      waiting: Object.values(message.pending).reduce((a, b) => a + b, 0),
      held: message.held,
    });
  }

  // The source reads a page after the crawl requested it, so its request is
  // the latest one of its URL.
  #extracted({ url, extracted }: PageExtracted): void {
    this.#run.pages += 1;
    if (extracted === null) {
      this.#run.unchanged += 1;
    }
    const request = this.#run.log.find((logged) => logged.url === url);
    if (request === undefined) {
      return;
    }
    request.page =
      extracted === null
        ? { kind: 'unchanged' }
        : { kind: 'extracted', records: extracted.records };
  }

  #end(
    status: NonNullable<Run['ended']>['status'],
    error: string | null,
  ): void {
    this.#run.ended = { at: Date.now(), status, error };
  }
}

// Node's code names a network failure, such as ECONNRESET.
function reason(error: unknown): string {
  if (!Error.isError(error)) {
    return String(error);
  }
  return 'code' in error && typeof error.code === 'string'
    ? `${error.code}: ${error.message}`
    : error.message;
}
