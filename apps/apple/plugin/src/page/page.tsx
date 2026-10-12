import { useApp, useHostStyles } from '@modelcontextprotocol/ext-apps/react';

import { ConnectorDetail } from './connector-detail.tsx';
import { ConnectorList } from './connector-list.tsx';
import { PageProvider, usePage } from './page-context.tsx';
import { Sidebar } from './sidebar.tsx';

// The Apple page ChatGPT lists in its sidebar: its own sidebar beside the
// connector list, or beside one connector's page.
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
      </div>
    </PageProvider>
  );
}

function OpenedConnector() {
  const { rows, opened } = usePage();
  const row = rows?.find(({ name }) => name === opened);
  return row === undefined ? <ConnectorList /> : <ConnectorDetail row={row} />;
}
