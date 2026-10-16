import type { MonitorRow } from './contract.ts';
import { usePage } from './page-context.tsx';

// One monitor: its status, what it watches in the user's words, and the
// instruction it sends to the chat that set it up.
export function MonitorDetail({ monitor }: { monitor: MonitorRow }) {
  const { app } = usePage();
  const { chat } = monitor;
  return (
    <main className="page">
      <h2>{monitor.title}</h2>
      <div className="status">
        <p
          className={`text-small ${monitor.status.state === 'failed' ? 'text-destructive' : 'text-muted'}`}
        >
          {monitor.status.text}
        </p>
      </div>
      <section className="card">
        <h3>When</h3>
        <p>{monitor.description}</p>
      </section>
      <section className="card">
        <h3>Then</h3>
        <p>“{monitor.instruction}”</p>
        <p className="text-small text-muted">
          Sent to the chat that set it up.
        </p>
        {chat !== null && app !== null && (
          <div className="actions">
            <button
              type="button"
              className="btn"
              onClick={() => void app.openLink({ url: chat })}
            >
              Open chat ↗
            </button>
          </div>
        )}
      </section>
      <p className="text-small text-muted">Checked after each Sync.</p>
    </main>
  );
}
