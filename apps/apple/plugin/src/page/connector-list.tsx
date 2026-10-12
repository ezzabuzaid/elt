import { ConnectorStatus } from './connector-status.tsx';
import { ConnectorSwitch } from './connector-switch.tsx';
import type { ConnectorRow } from './contract.ts';
import { usePage } from './page-context.tsx';

// Every connector with its switch and import status.
export function ConnectorList() {
  const { rows, failure } = usePage();
  return (
    <main className="page">
      <header className="header">
        <h2>Connectors</h2>
      </header>
      {failure !== null && (
        <p role="alert" className="text-small text-destructive">
          {failure}
        </p>
      )}
      {rows === null ? (
        <p className="text-muted">Reading your connectors…</p>
      ) : (
        <ul className="rows">
          {rows.map((row) => (
            <ConnectorItem key={row.name} row={row} />
          ))}
        </ul>
      )}
    </main>
  );
}

// A connector that is not loaded has no page of its own: it can only be
// switched off.
function ConnectorItem({ row }: { row: ConnectorRow }) {
  const { open } = usePage();
  return (
    <li className="row">
      <div className="row-text">
        {row.loaded ? (
          <button
            type="button"
            className="row-title"
            onClick={() => open(row.name)}
          >
            {row.title}
          </button>
        ) : (
          <span className="row-title">{row.title}</span>
        )}
        <ConnectorStatus row={row} />
      </div>
      <ConnectorSwitch row={row} />
      {row.loaded && (
        <button
          type="button"
          className="btn btn-ghost"
          aria-label={`Open ${row.title}`}
          onClick={() => open(row.name)}
        >
          ›
        </button>
      )}
    </li>
  );
}
