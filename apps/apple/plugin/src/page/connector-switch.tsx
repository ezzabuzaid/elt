import { useState } from 'react';

import { messageOf } from './call-tool.ts';
import { ConfirmDialog } from './confirm-dialog.tsx';
import type { ConnectorRow, ConnectorSelection } from './contract.ts';
import { usePage } from './page-context.tsx';

// A connector's on/off switch. Turning one on imports everything, which its
// detail page can narrow; turning one off deletes its import, so it asks
// first. A connector that is not loaded can only be turned off.
export function ConnectorSwitch({ row }: { row: ConnectorRow }) {
  const { update } = usePage();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const on = row.selection !== null;

  const change = async (selection: Partial<ConnectorSelection> | null) => {
    setBusy(true);
    try {
      await update(row.name, selection);
      setFailure(null);
    } catch (error) {
      setFailure(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <input
        type="checkbox"
        role="switch"
        className="switch"
        aria-label={`${row.title} connected`}
        checked={on}
        disabled={busy || (!row.loaded && !on)}
        onChange={() => {
          if (on) setConfirming(true);
          else void change({});
        }}
      />
      {failure !== null && (
        <p role="alert" className="text-small text-destructive">
          {failure}
        </p>
      )}
      {confirming && (
        <ConfirmDialog
          title={`Turn off ${row.title}?`}
          body={`This deletes ${row.title}’s imported copy. Turning it on again imports it from the start.`}
          confirm="Turn off"
          onConfirm={() => {
            setConfirming(false);
            void change(null);
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </>
  );
}
