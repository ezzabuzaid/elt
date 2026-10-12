import type { App } from '@modelcontextprotocol/ext-apps';
import { type ReactNode, useEffect, useState } from 'react';

import { callTool, messageOf } from './call-tool.ts';
import { ConnectorStatus } from './connector-status.tsx';
import { ConnectorSwitch, type Update } from './connector-switch.tsx';
import {
  type ConnectorChoices,
  type ConnectorRow,
  choicesResult,
} from './contract.ts';
import { ScopeForm } from './scope-form.tsx';

// One connector: its switch, its status and what it imports. Its choices are
// read from its Apple app only when this page opens, since reading them may
// make macOS ask for access.
export function ConnectorDetail({
  app,
  row,
  onBack,
  onUpdate,
  onOpenFullDiskAccess,
}: {
  app: App;
  row: ConnectorRow;
  onBack: () => void;
  onUpdate: Update;
  onOpenFullDiskAccess: () => Promise<void>;
}) {
  const [choices, setChoices] = useState<ConnectorChoices | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    const read = new AbortController();
    callTool(
      app,
      'apple_connector_choices',
      { connector: row.name },
      choicesResult,
    ).then(
      (result) => {
        if (!read.signal.aborted) setChoices(result);
      },
      (error: unknown) => {
        if (!read.signal.aborted) setFailure(messageOf(error));
      },
    );
    return () => read.abort();
  }, [app, row.name]);

  let whatToImport: ReactNode;
  if (failure !== null) {
    whatToImport = (
      <p role="alert" className="text-small text-destructive">
        {failure}
      </p>
    );
  } else if (choices === null) {
    whatToImport = (
      <p className="text-small text-muted">
        Reading {row.title}’s accounts and collections. macOS may ask for
        access.
      </p>
    );
  } else {
    whatToImport = (
      <ScopeForm
        key={JSON.stringify(row.selection)}
        row={row}
        choices={choices}
        onUpdate={onUpdate}
      />
    );
  }

  return (
    <main className="page">
      <button type="button" className="btn btn-ghost" onClick={onBack}>
        ‹ Connectors
      </button>
      <header className="header detail">
        <h2>{row.title}</h2>
        <ConnectorSwitch row={row} onUpdate={onUpdate} />
      </header>
      <ConnectorStatus row={row} onOpenFullDiskAccess={onOpenFullDiskAccess} />
      <section className="card">
        <h3>What to import</h3>
        {whatToImport}
      </section>
    </main>
  );
}
