import { errorMessage } from '../state/sync-history.ts';
import type { DerivedStatus } from './derived-status.ts';

// Publishes a view, which appears once its query compiles, so a reader never
// finds a view that fails. Until a copy of the pipeline has made each
// relation it reads, and each derived dataset before it that it reads has
// appeared, it waits, as dbt skips a model whose upstream model was skipped:
// missing gives the relation that the store's error names, or undefined, and
// awaited holds the relations that the copies and the earlier datasets make,
// both as the store names them. Any other error is the view's own failure.
export async function refreshView({
  publish,
  missing,
  awaited,
  status,
}: {
  readonly publish: () => Promise<void>;
  readonly missing: (error: unknown) => string | undefined;
  readonly awaited: ReadonlySet<string>;
  readonly status: DerivedStatus;
}): Promise<void> {
  try {
    await publish();
  } catch (error) {
    const relation = missing(error);
    if (relation !== undefined && awaited.has(relation)) {
      await status.waiting();
      return;
    }
    await status.failed(errorMessage(error));
    throw error;
  }
  await status.current();
}
