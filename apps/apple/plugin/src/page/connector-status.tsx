import { useState } from 'react';

import { callTool, messageOf } from './call-tool.ts';
import type { ConnectorRow } from './contract.ts';
import { usePage } from './page-context.tsx';

// A connector's import status, with a button that opens Full Disk Access when
// granting it is what the failure needs.
export function ConnectorStatus({ row }: { row: ConnectorRow }) {
  const { app } = usePage();
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
      {row.status.details.map((detail) => (
        <p key={detail} className="text-small text-muted">
          {detail}
        </p>
      ))}
      {row.status.fullDiskAccess && app !== null && (
        <button
          type="button"
          className="btn"
          onClick={() => {
            callTool(app, 'apple_open_full_disk_access', {}, {}).then(
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
