import { type ReactNode, useState } from 'react';

import { messageOf } from './call-tool.ts';
import type { ConnectorRow } from './contract.ts';
import { usePage } from './page-context.tsx';

// The Apple page's sidebar, drawn like the sidebar of ChatGPT's Space: its
// title with Sync, which imports every connected connector again and turns
// until the last pass ends, then its monitors and its connectors, each a
// section that folds away.
export function Sidebar() {
  const { rows, sync, syncing } = usePage();
  const [failure, setFailure] = useState<string | null>(null);
  const label = syncing ? 'Syncing connectors' : 'Sync connectors';
  return (
    <nav className="sidebar" aria-label="Apple">
      <header className="sidebar-title">
        <h2>Apple</h2>
        <button
          type="button"
          className="icon-button"
          aria-label={label}
          aria-busy={syncing}
          title={label}
          disabled={syncing}
          onClick={() => {
            sync().then(
              () => setFailure(null),
              (error: unknown) => setFailure(messageOf(error)),
            );
          }}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
            <path d="M21 3v5h-5" />
            <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
            <path d="M8 16H3v5" />
          </svg>
        </button>
      </header>
      {failure !== null && (
        <p role="alert" className="text-small text-destructive sidebar-failure">
          {failure}
        </p>
      )}
      <Section title="Monitors" />
      <Section title="Connectors">
        {rows?.map((row) => (
          <ConnectorLink key={row.name} row={row} />
        ))}
      </Section>
    </nav>
  );
}

function Section({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <details className="section" open>
      <summary>
        {title}
        <svg className="disclosure" viewBox="0 0 16 16" aria-hidden="true">
          <path d="m4.5 6.25 3.5 3.5 3.5-3.5" />
        </svg>
      </summary>
      <ul>{children}</ul>
    </details>
  );
}

// A connector that is not loaded has no page of its own to open.
function ConnectorLink({ row }: { row: ConnectorRow }) {
  const { opened, open } = usePage();
  const label = (
    <>
      <StatusGlyph row={row} />
      <span className="item-title">{row.title}</span>
    </>
  );
  return (
    <li>
      {row.loaded ? (
        <button
          type="button"
          className="item"
          aria-current={opened === row.name ? 'page' : undefined}
          onClick={() => open(row.name)}
        >
          {label}
        </button>
      ) : (
        <span className="item">{label}</span>
      )}
    </li>
  );
}

// ● synced, a turning arc while it waits or imports, ✕ when it needs the
// user, ○ when it is off. It reads as the status line the connector's page
// shows.
function StatusGlyph({ row }: { row: ConnectorRow }) {
  const { state, text } = row.status;
  let glyph: 'synced' | 'busy' | 'troubled' | 'off' = 'synced';
  if (!row.loaded || state === 'failed' || state === 'partial')
    glyph = 'troubled';
  else if (state === 'waiting' || state === 'running') glyph = 'busy';
  else if (state === 'off' || state === 'cancelled') glyph = 'off';
  return (
    <svg
      className={`glyph ${glyph}`}
      viewBox="0 0 16 16"
      role="img"
      aria-label={text}
    >
      {
        {
          synced: <circle cx="8" cy="8" r="3.5" />,
          busy: <path d="M8 4.5a3.5 3.5 0 1 1-3.5 3.5" />,
          troubled: <path d="m5.5 5.5 5 5m0-5-5 5" />,
          off: <circle cx="8" cy="8" r="3.25" />,
        }[glyph]
      }
    </svg>
  );
}
