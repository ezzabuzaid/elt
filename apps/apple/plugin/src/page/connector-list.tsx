import { ConnectorStatus } from './connector-status.tsx';
import { ConnectorSwitch, type Update } from './connector-switch.tsx';
import type { ConnectorRow } from './contract.ts';

// Every connector with its switch and import status; a loaded connector opens
// its detail page.
export function ConnectorList({
  rows,
  failure,
  onOpen,
  onUpdate,
  onOpenFullDiskAccess,
}: {
  rows: readonly ConnectorRow[];
  failure: string | null;
  onOpen: (connector: string) => void;
  onUpdate: Update;
  onOpenFullDiskAccess: () => Promise<void>;
}) {
  return (
    <main className="page">
      <header className="header">
        <h2>Apple</h2>
        <p className="text-muted">Connectors</p>
      </header>
      {failure !== null && (
        <p role="alert" className="text-small text-destructive">
          {failure}
        </p>
      )}
      <ul className="rows">
        {rows.map((row) => (
          <li key={row.name} className="row">
            <div className="row-text">
              {row.loaded ? (
                <button
                  type="button"
                  className="row-title"
                  onClick={() => onOpen(row.name)}
                >
                  {row.title}
                </button>
              ) : (
                <span className="row-title">{row.title}</span>
              )}
              <ConnectorStatus
                row={row}
                onOpenFullDiskAccess={onOpenFullDiskAccess}
              />
            </div>
            <ConnectorSwitch row={row} onUpdate={onUpdate} />
            {row.loaded && (
              <button
                type="button"
                className="btn btn-ghost"
                aria-label={`Open ${row.title}`}
                onClick={() => onOpen(row.name)}
              >
                ›
              </button>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}
