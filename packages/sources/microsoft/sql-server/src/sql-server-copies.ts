import { Copy, type Target } from '@workspace/elt';

import type { SqlServerSource } from './sql-server-source.ts';

/**
 * Every table as a copy into `target(stream)`: an incremental copy that
 * applies changes by key for a stream that reads changes, and a full
 * refresh that replaces the target for one that reads every row. Each copy
 * is named after its stream, so its checkpoint follows the table.
 */
export function sqlServerCopies<T extends Target>(
  source: SqlServerSource,
  target: (stream: string) => T,
): Copy<T>[] {
  return source.streams.map((stream) => {
    const mode = stream.sourceDefinedCursor
      ? ({
          syncMode: 'incremental',
          destinationSyncMode: 'append_dedup',
        } as const)
      : ({
          syncMode: 'full_refresh',
          destinationSyncMode: 'overwrite',
        } as const);
    return new Copy(stream, target(stream.name), { id: stream.name, ...mode });
  });
}
