import { useApp, useHostStyles } from '@modelcontextprotocol/ext-apps/react';
import { useState } from 'react';

import { callTool } from './call-tool.ts';
import { ConnectorDetail } from './connector-detail.tsx';
import { ConnectorList } from './connector-list.tsx';
import { useConnectors } from './use-connectors.ts';

// The Apple page ChatGPT lists in its sidebar: the connector list, or one
// connector's detail.
export function Page() {
  const { app, error } = useApp({
    appInfo: { name: 'apple-page', version: '1.0.0' },
    capabilities: {},
  });
  useHostStyles(app, app?.getHostContext());
  const { rows, failure, update } = useConnectors(app);
  const [opened, setOpened] = useState<string | null>(null);

  if (error !== null)
    return (
      <main className="page">
        <p role="alert" className="text-destructive">
          {error.message}
        </p>
      </main>
    );
  if (app === null || rows === null)
    return (
      <main className="page">
        <p className={failure === null ? 'text-muted' : 'text-destructive'}>
          {failure ?? 'Reading your connectors…'}
        </p>
      </main>
    );
  const openFullDiskAccess = async () => {
    await callTool(app, 'apple_open_full_disk_access', {}, {});
  };
  const row = rows.find(({ name }) => name === opened);
  return row === undefined ? (
    <ConnectorList
      rows={rows}
      failure={failure}
      onOpen={setOpened}
      onUpdate={update}
      onOpenFullDiskAccess={openFullDiskAccess}
    />
  ) : (
    <ConnectorDetail
      app={app}
      row={row}
      onBack={() => setOpened(null)}
      onUpdate={update}
      onOpenFullDiskAccess={openFullDiskAccess}
    />
  );
}
