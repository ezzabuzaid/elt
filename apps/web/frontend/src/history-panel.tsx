import { useQuery } from '@tanstack/react-query';

import type { Attempt } from '../../src/contract.ts';
import { api } from './api.ts';
import { formatTime } from './format.ts';

export function HistoryPanel() {
  const history = useQuery({ queryKey: ['history'], queryFn: api.history });
  if (history.data === undefined || history.data.attempts.length === 0)
    return null;
  const { currentAsOf, attempts } = history.data;
  return (
    <section className="history">
      <h2>History</h2>
      {currentAsOf !== null && (
        <p className="note">Current as of {formatTime(currentAsOf)}</p>
      )}
      <ol>
        {attempts.map((attempt) => (
          <AttemptRow key={attempt.attempt_id} attempt={attempt} />
        ))}
      </ol>
    </section>
  );
}

function AttemptRow({ attempt }: { attempt: Attempt }) {
  return (
    <li>
      <details>
        <summary>
          <span className="attempt">#{attempt.attempt_id}</span>
          <span className={`status ${attempt.status}`}>{attempt.status}</span>
          <span className="when">{formatTime(attempt.started_at)}</span>
          {attempt.written_count !== null && (
            <span className="counts">
              +{attempt.written_count} −{attempt.deleted_count ?? 0}
            </span>
          )}
        </summary>
        <dl>
          {attempt.completed_at !== null && (
            <>
              <dt>Completed</dt>
              <dd>{formatTime(attempt.completed_at)}</dd>
            </>
          )}
          {attempt.error !== null && (
            <>
              <dt>
                Error{attempt.failure_type && ` (${attempt.failure_type})`}
              </dt>
              <dd className="error">{attempt.error}</dd>
            </>
          )}
          {attempt.description !== null && (
            <>
              <dt>Coverage</dt>
              <dd>{attempt.description}</dd>
            </>
          )}
          <dt>Selection</dt>
          <dd>
            <pre>{JSON.stringify(attempt.selection, null, 2)}</pre>
          </dd>
          {Array.isArray(attempt.failures) && attempt.failures.length > 0 && (
            <>
              <dt>Failures</dt>
              <dd>
                <pre>{JSON.stringify(attempt.failures, null, 2)}</pre>
              </dd>
            </>
          )}
        </dl>
      </details>
    </li>
  );
}
