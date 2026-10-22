import type { ReactNode } from 'react';

import { ConnectorMenu } from './connector-menu.tsx';
import { ConnectorSwitch } from './connector-switch.tsx';
import type { ConnectorRow, MonitorRow } from './contract.ts';
import { MonitorMenu } from './monitor-menu.tsx';
import { usePage } from './page-context.tsx';

// The Apple page's sidebar, drawn like the sidebar of ChatGPT's Space: its
// title with Sync, which imports every connected connector again and turns
// until the last pass ends, the page's failure to read or sync, then its
// monitors and its connectors, each a section that folds away.
export function Sidebar() {
  const {
    rows,
    monitors,
    failure,
    sync,
    syncing,
    openedTranscription,
    openTranscription,
  } = usePage();
  const label = syncing ? 'Syncing connectors' : 'Sync connectors';
  return (
    <nav className="sidebar" aria-label="Apple">
      <header className="sidebar-title">
        <h2>Apple</h2>
        {/* Its icon is copied in connector-menu.tsx: change both. */}
        <button
          type="button"
          className="icon-button"
          aria-label={label}
          aria-busy={syncing}
          title={label}
          disabled={syncing}
          onClick={() => void sync()}
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
      <Section title="Monitors">
        {monitors?.length === 0 && (
          <li className="empty text-small text-muted">
            None yet. In a chat, ask: When …, then …
          </li>
        )}
        {monitors?.map((monitor) => (
          <MonitorLink key={monitor.name} monitor={monitor} />
        ))}
      </Section>
      <Section title="Connectors">
        {rows?.map((row) => (
          <ConnectorLink key={row.name} row={row} />
        ))}
      </Section>
      <button
        type="button"
        className="item transcription-link"
        aria-current={openedTranscription ? 'page' : undefined}
        onClick={openTranscription}
      >
        Audio transcription
      </button>
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

// A connector with its status on hover, its menu on right-click and its
// switch at the end. One that is not loaded has no page of its own to open,
// only its switch to turn off.
function ConnectorLink({ row }: { row: ConnectorRow }) {
  const { opened, open } = usePage();
  const label = (
    <>
      <StatusGlyph row={row} />
      <span className="item-title">{row.title}</span>
      {row.watched && <span className="item-note">Watching</span>}
    </>
  );
  return (
    <li>
      {row.loaded ? (
        <ConnectorMenu row={row}>
          <button
            type="button"
            className="item"
            title={row.status.text}
            aria-current={opened === row.name ? 'page' : undefined}
            onClick={() => open(row.name)}
          >
            {label}
          </button>
        </ConnectorMenu>
      ) : (
        <span className="item" title={row.status.text}>
          {label}
        </span>
      )}
      <ConnectorSwitch row={row} />
    </li>
  );
}

// A monitor with its status on hover and its menu on right-click; it has no
// switch, since a sync checks every monitor.
function MonitorLink({ monitor }: { monitor: MonitorRow }) {
  const { openedMonitor, openMonitor } = usePage();
  const glyphs = {
    watching: 'synced',
    failed: 'troubled',
    inactive: 'off',
  } as const;
  return (
    <li>
      <MonitorMenu monitor={monitor}>
        <button
          type="button"
          className="item"
          title={monitor.status.text}
          aria-current={openedMonitor === monitor.name ? 'page' : undefined}
          onClick={() => openMonitor(monitor.name)}
        >
          <Glyph
            glyph={glyphs[monitor.status.state]}
            label={monitor.status.text}
          />
          <span className="item-title">{monitor.title}</span>
        </button>
      </MonitorMenu>
    </li>
  );
}

// ● synced, a turning arc while it waits or imports, ✕ when it needs the
// user, ○ when it is off. It reads as the status line the connector's page
// shows.
function StatusGlyph({ row }: { row: ConnectorRow }) {
  const { state, text } = row.status;
  let glyph: Glyph = 'synced';
  if (!row.loaded || state === 'failed' || state === 'partial')
    glyph = 'troubled';
  else if (state === 'waiting' || state === 'running') glyph = 'busy';
  else if (state === 'off' || state === 'cancelled') glyph = 'off';
  return <Glyph glyph={glyph} label={text} />;
}

type Glyph = 'synced' | 'busy' | 'troubled' | 'off';

function Glyph({ glyph, label }: { glyph: Glyph; label: string }) {
  return (
    <svg
      className={`glyph ${glyph}`}
      viewBox="0 0 16 16"
      role="img"
      aria-label={label}
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
