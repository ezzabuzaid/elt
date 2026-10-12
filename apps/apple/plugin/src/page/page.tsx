import { useApp, useHostStyles } from '@modelcontextprotocol/ext-apps/react';

import { ConnectorDetail } from './connector-detail.tsx';
import { ConnectorList } from './connector-list.tsx';
import { PageProvider, usePage } from './page-context.tsx';

// The Apple page ChatGPT lists in its sidebar: the connector list, or one
// connector's page.
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
      <OpenedConnector />
    </PageProvider>
  );
}

function OpenedConnector() {
  const { rows, opened } = usePage();
  const row = rows?.find(({ name }) => name === opened);
  return row === undefined ? <ConnectorList /> : <ConnectorDetail row={row} />;
}
