import type { App } from '@modelcontextprotocol/ext-apps';
import { useCallback, useEffect, useState } from 'react';

import { callTool, messageOf } from './call-tool.ts';
import {
  type ConnectorRow,
  type ConnectorSelection,
  connectorsResult,
} from './contract.ts';

// The server cannot tell the page that an import moved on, so the page asks
// again: soon while an import waits or runs, rarely once all are settled, and
// not at all while ChatGPT hides the page.
const busyDelay = 2_000;
const settledDelay = 15_000;

export function useConnectors(app: App | null) {
  const [rows, setRows] = useState<readonly ConnectorRow[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [reads, setReads] = useState(0);

  const read = useCallback(async () => {
    if (app === null) return;
    try {
      const { connectors } = await callTool(
        app,
        'apple_connectors',
        {},
        connectorsResult,
      );
      setRows(connectors);
      setFailure(null);
    } catch (error) {
      setFailure(messageOf(error));
    } finally {
      setReads((count) => count + 1);
    }
  }, [app]);

  useEffect(() => {
    if (app === null) return;
    const busy = rows?.some(
      ({ status }) => status.state === 'waiting' || status.state === 'running',
    );
    let delay = settledDelay;
    if (reads === 0) delay = 0;
    else if (busy === true) delay = busyDelay;
    const timer = setTimeout(() => {
      if (!document.hidden) void read();
    }, delay);
    return () => clearTimeout(timer);
  }, [app, reads, rows, read]);

  useEffect(() => {
    const shown = () => {
      if (!document.hidden) void read();
    };
    document.addEventListener('visibilitychange', shown);
    return () => document.removeEventListener('visibilitychange', shown);
  }, [read]);

  // Changes one connector and shows the rows the server returns at once.
  const update = useCallback(
    async (
      connector: string,
      selection: Partial<ConnectorSelection> | null,
    ) => {
      if (app === null) return;
      const { connectors } = await callTool(
        app,
        'apple_connector_update',
        { connector, selection },
        connectorsResult,
      );
      setRows(connectors);
      setFailure(null);
    },
    [app],
  );

  return { rows, failure, update };
}
