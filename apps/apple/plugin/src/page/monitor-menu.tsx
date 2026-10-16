import * as ContextMenu from '@radix-ui/react-context-menu';
import { type ReactElement, useState } from 'react';

import { messageOf } from './call-tool.ts';
import { ConfirmDialog } from './confirm-dialog.tsx';
import type { MonitorRow } from './contract.ts';
import { usePage } from './page-context.tsx';

// A monitor's menu, opened like a connector's: right-click at the pointer.
// Its Remove asks first, since it deletes the monitor's folder.
export function MonitorMenu({
  monitor,
  children,
}: {
  monitor: MonitorRow;
  children: ReactElement;
}) {
  const { removeMonitor } = usePage();
  const [confirming, setConfirming] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  return (
    <>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className="menu" collisionPadding={6}>
            <ContextMenu.Item
              className="menu-item"
              onSelect={() => setConfirming(true)}
            >
              Remove
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      {confirming && (
        <ConfirmDialog
          title={`Remove ${monitor.title}?`}
          body="It stops sending to its chat, and its folder is deleted."
          confirm="Remove"
          onConfirm={() => {
            setConfirming(false);
            removeMonitor(monitor.name).then(
              () => setFailure(null),
              (error: unknown) => setFailure(messageOf(error)),
            );
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
      {failure !== null && (
        <p role="alert" className="text-small text-destructive">
          {failure}
        </p>
      )}
    </>
  );
}
