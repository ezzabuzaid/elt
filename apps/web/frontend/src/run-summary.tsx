import { useSyncExternalStore } from 'react';

import type { Run } from '../../src/contract.ts';
import {
  formatClock,
  formatCount,
  formatElapsed,
  formatTime,
} from './format.ts';

const labels = {
  succeeded: 'Succeeded',
  partial: 'Partial',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

// The totals of the last Sync. Only its state is a live region: a reader
// hears that the crawl started and how it ended, not every count.
export function RunSummary({ run }: { run: Run }) {
  const { ended } = run;
  return (
    <section className="run" aria-label="Last sync">
      <p
        role="status"
        aria-atomic="true"
        className={`status ${ended?.status ?? 'running'}`}
      >
        {ended === null ? 'Crawling' : labels[ended.status]}
      </p>
      <dl className="activity">
        <dt>Time</dt>
        <dd>
          {ended === null ? (
            <Elapsed from={run.startedAt} />
          ) : (
            formatElapsed(ended.at - run.startedAt)
          )}
        </dd>
        <dt>Requests</dt>
        <dd>
          {formatCount(run.requests)}
          {run.failed > 0 && (
            <span className="bad"> · {formatCount(run.failed)} failed</span>
          )}
        </dd>
        {ended === null && (
          <>
            <dt>Waiting</dt>
            <dd>
              {formatCount(run.waiting)}
              {run.held > 0 && ` · ${formatCount(run.held)} held`}
            </dd>
          </>
        )}
        <dt>Pages</dt>
        <dd>
          {formatCount(run.pages)}
          {run.unchanged > 0 && ` · ${formatCount(run.unchanged)} unchanged`}
        </dd>
        <dt>Written</dt>
        <dd>{formatCount(run.written)}</dd>
        {ended !== null && run.nextDue !== null && (
          <>
            <dt>Next crawl</dt>
            <dd>{formatTime(run.nextDue)}</dd>
          </>
        )}
        {run.blocks.map(({ origin, until }) => (
          <Blocked key={origin} origin={origin} until={until} />
        ))}
      </dl>
      {ended?.error && <p className="error">{ended.error}</p>}
    </section>
  );
}

function Blocked({ origin, until }: { origin: string; until: number }) {
  return (
    <>
      <dt>Blocked</dt>
      <dd className="bad">
        {new URL(origin).host} until {formatClock(until)}
      </dd>
    </>
  );
}

// The time since from, to the second, while it shows.
function Elapsed({ from }: { from: number }) {
  const now = useSyncExternalStore(everySecond, thisSecond);
  return formatElapsed(now - from);
}

const everySecond = (tick: () => void) => {
  const timer = setInterval(tick, 1000);
  return () => clearInterval(timer);
};
const thisSecond = () => Math.floor(Date.now() / 1000) * 1000;
