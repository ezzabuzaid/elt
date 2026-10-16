import { useApp, useHostStyles } from '@modelcontextprotocol/ext-apps/react';

import { ConnectorDetail } from './connector-detail.tsx';
import { MonitorDetail } from './monitor-detail.tsx';
import { PageProvider, usePage } from './page-context.tsx';
import { Sidebar } from './sidebar.tsx';

// The Apple page ChatGPT lists in its sidebar: its own sidebar, beside the
// page of the connector or monitor it opened.
export function Page() {
  const { app, error } = useApp({
    appInfo: { name: 'apple-page', version: '1.0.0' },
    capabilities: {},
  });
  useHostStyles(app, app?.getHostContext());
  if (error !== null)
    return (
      <main className="page">
        <p role="alert" className="text-destructive">
          {error.message}
        </p>
      </main>
    );
  return (
    <PageProvider app={app}>
      <div className="shell">
        <Sidebar />
        <OpenedConnector />
        <OpenedMonitor />
      </div>
    </PageProvider>
  );
}

function OpenedConnector() {
  const { rows, opened } = usePage();
  const row = rows?.find(({ name }) => name === opened);
  return row === undefined ? null : <ConnectorDetail row={row} />;
}

function OpenedMonitor() {
  const { monitors, openedMonitor } = usePage();
  const monitor = monitors?.find(({ name }) => name === openedMonitor);
  return monitor === undefined ? null : <MonitorDetail monitor={monitor} />;
}
