import type { CrawlRequest, Run } from '../../src/contract.ts';
import { formatCount, formatMilliseconds, shortUrl } from './format.ts';

// The latest requests of the last Sync, newest first, as a crawl log's tail.
// The box stops growing at its height, so the articles below stay put once
// it fills.
export function CrawlLog({ run }: { run: Run }) {
  if (run.log.length === 0) {
    return null;
  }
  return (
    <section className="crawl" aria-busy={run.ended === null}>
      <h2>
        Requests <span className="count">{formatCount(run.requests)}</span>
      </h2>
      <div className="requests">
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>URL</th>
              <th>Time</th>
              <th>Waited</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {run.log.map((request) => (
              <RequestRow key={request.id} request={request} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RequestRow({ request }: { request: CrawlRequest }) {
  const { outcome, url, waited, failed } = request;
  return (
    <tr>
      <td className={failed ? 'bad' : 'good'}>
        {outcome.kind === 'answered' ? outcome.status : 'error'}
      </td>
      <td className="url">
        <a href={url} target="_blank" rel="noreferrer" title={url}>
          {shortUrl(url)}
        </a>
      </td>
      <td>
        {outcome.kind === 'answered' &&
          (outcome.duration === null
            ? 'cached'
            : formatMilliseconds(outcome.duration))}
      </td>
      {/* The column shows hundredths of a second. */}
      <td>{waited >= 10 && formatMilliseconds(waited)}</td>
      <td className={failed ? 'bad result' : 'result'}>
        <Result request={request} />
      </td>
    </tr>
  );
}

function Result({
  request: { outcome, page, list },
}: {
  request: CrawlRequest;
}) {
  if (outcome.kind === 'errored') {
    return <span title={outcome.error}>{outcome.error}</span>;
  }
  if (page?.kind === 'extracted') {
    return `${formatCount(page.records)} ${page.records === 1 ? 'record' : 'records'}`;
  }
  if (page?.kind === 'unchanged') {
    return 'unchanged';
  }
  return list ? 'list' : null;
}
