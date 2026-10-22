import { useState } from 'react';

import { messageOf } from './call-tool.ts';
import type { ConnectorRow } from './contract.ts';
import { usePage } from './page-context.tsx';

// A connected connector's Keep current switch: on, it loads each change while
// ChatGPT is open; off, it loads only when the user presses Sync.
export function KeepCurrent({ row }: { row: ConnectorRow }) {
  const { watch } = usePage();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const change = async (watched: boolean) => {
    setBusy(true);
    try {
      await watch(row.name, watched);
      setFailure(null);
    } catch (error) {
      setFailure(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card scope">
      <label className="toggle">
        <span>Keep current</span>
        <input
          type="checkbox"
          role="switch"
          className="switch"
          checked={row.watched}
          disabled={busy}
          onChange={(event) => void change(event.target.checked)}
        />
      </label>
      <p className="text-small text-muted">
        Loads each change while ChatGPT is open, without pressing Sync.
      </p>
      {failure !== null && (
        <p role="alert" className="text-small text-destructive">
          {failure}
        </p>
      )}
    </section>
  );
}
