import { useState } from 'react';

import { messageOf } from './call-tool.ts';
import type { ConnectorRow } from './contract.ts';

// A connector's import status, with a button that opens Full Disk Access when
// granting it is what the failure needs.
export function ConnectorStatus({
  row,
  onOpenFullDiskAccess,
}: {
  row: ConnectorRow;
  onOpenFullDiskAccess: () => Promise<void>;
}) {
  const [failure, setFailure] = useState<string | null>(null);
  const troubled =
    !row.loaded ||
    row.status.state === 'failed' ||
    row.status.state === 'partial';
  return (
    <div className="status">
      <p
        className={`text-small ${troubled ? 'text-destructive' : 'text-muted'}`}
      >
        {row.status.text}
      </p>
      {row.status.fullDiskAccess && (
        <button
          type="button"
          className="btn"
          onClick={() => {
            onOpenFullDiskAccess().then(
              () => setFailure(null),
              (error: unknown) => setFailure(messageOf(error)),
            );
          }}
        >
          Open Full Disk Access
        </button>
      )}
      {failure !== null && (
        <p role="alert" className="text-small text-destructive">
          {failure}
        </p>
      )}
    </div>
  );
}
