import * as ContextMenu from '@radix-ui/react-context-menu';
import type { KeyboardEvent, ReactElement } from 'react';

import type { ConnectorRow } from './contract.ts';
import { usePage } from './page-context.tsx';

// A connected connector's menu, opened as ChatGPT opens its own rows' menus:
// right-click opens it at the pointer, and the menu key or Shift+F10 at the
// focused row. Its Sync imports that connector alone, also while the row reads
// importing: a pass that still runs is joined, and one a killed process left is
// replaced. A connector that is off has no menu. ChatGPT keeps Escape from its
// apps' pages, so there the menu closes on a click outside it or on its Sync.
export function ConnectorMenu({
  row,
  children,
}: {
  row: ConnectorRow;
  children: ReactElement;
}) {
  const { sync, syncing, syncingConnectors } = usePage();
  const busy = syncing || syncingConnectors.has(row.name);
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger
        asChild
        disabled={row.selection === null}
        onKeyDown={openFromKeyboard}
      >
        {children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="menu" collisionPadding={6}>
          <ContextMenu.Item
            className="menu-item"
            disabled={busy}
            onSelect={() => void sync(row.name)}
          >
            {/* A copy of the Sync icon beside the sidebar's title
                (sidebar.tsx): change both. */}
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
              <path d="M21 3v5h-5" />
              <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
              <path d="M8 16H3v5" />
            </svg>
            Sync
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

// The keyboard opens the menu as a right-click at the row's lower start
// corner would, the way ChatGPT's own rows do.
function openFromKeyboard(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey))
    return;
  event.preventDefault();
  const { left, bottom } = event.currentTarget.getBoundingClientRect();
  event.currentTarget.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: left,
      clientY: bottom,
    }),
  );
}
