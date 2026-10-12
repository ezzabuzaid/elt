import type { App } from '@modelcontextprotocol/ext-apps';
import { OpenAIExtensions } from '@openai/mcp-extensions/app';
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';

import { callTool, messageOf } from './call-tool.ts';
import {
  type ConnectorRow,
  type ConnectorSelection,
  connectorIn,
  connectorsResult,
} from './contract.ts';

// What every part of the Apple page shares: its connection to ChatGPT, the
// connector rows it keeps current, the one change it makes, and which
// connector's page is open.
type Page = {
  readonly app: App | null;
  readonly rows: readonly ConnectorRow[] | null;
  readonly failure: string | null;
  // What a selection leaves out takes the defaults setup uses.
  readonly update: (
    connector: string,
    selection: Partial<ConnectorSelection> | null,
  ) => Promise<void>;
  readonly opened: string | null;
  readonly open: (connector: string | null) => void;
};

const PageContext = createContext<Page | null>(null);

export function usePage(): Page {
  const page = useContext(PageContext);
  if (page === null) throw new Error('usePage needs a PageProvider above it.');
  return page;
}

// The server cannot tell the page that an import moved on, so the page asks
// again: soon while an import waits or runs, rarely once all are settled, and
// not at all while ChatGPT hides the page.
const busyDelay = 2_000;
const settledDelay = 15_000;

export function PageProvider({
  app,
  children,
}: {
  app: App | null;
  children: ReactNode;
}) {
  const [rows, setRows] = useState<readonly ConnectorRow[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [reads, setReads] = useState(0);
  const [opened, setOpened] = useState<string | null>(null);

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

  // A link to /connectors/<name> opens that connector; any other, the list.
  const link = useDeepLink(app);
  useEffect(() => {
    if (link !== undefined) setOpened(connectorIn(link) ?? null);
  }, [link]);

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

  return (
    <PageContext
      value={{ app, rows, failure, update, opened, open: setOpened }}
    >
      {children}
    </PageContext>
  );
}

// The deep link ChatGPT opened the page with, and each new one it sends while
// the page is open. Another host-context change, such as the theme, keeps the
// same link, so it does not move the page.
function useDeepLink(app: App | null): string | undefined {
  const [url, setUrl] = useState<string | undefined>();
  useEffect(() => {
    if (app === null) return;
    // OpenAI's extensions also apply ChatGPT's interaction cursor to the page.
    const { deepLink } = new OpenAIExtensions(app);
    const read = () => setUrl(deepLink.getCurrent()?.url);
    read();
    app.addEventListener('hostcontextchanged', read);
    return () => app.removeEventListener('hostcontextchanged', read);
  }, [app]);
  return url;
}
