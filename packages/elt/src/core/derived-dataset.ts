import { errorMessage } from '../state/sync-history.ts';
import type { Connection } from './connection.ts';
import type { Target as DestinationTarget } from './target.ts';

// Why the pipeline refreshes: a copy committed while its pass reads, or the
// passes ended. A commit refresh catches up with new and changed inputs; a
// pass refresh also tries again what failed, as a refresh after a pass did
// before commits asked for refreshes, so a failing input is tried at most
// once a pass. tried holds, for this dataset and only until the passes
// ended, the keys that commit refreshes of these passes tried: a commit
// refresh adds to it, and the pass refresh leaves them for the next pass.
export type RefreshTrigger =
  | { readonly kind: 'commit'; readonly tried: Set<string> }
  | { readonly kind: 'pass'; readonly tried: ReadonlySet<string> };

// A dataset's own failure, such as SQL its store refuses, named for whoever
// reads it in a log: the cause alone, such as "no such column: x", does not say
// which dataset of the pipeline failed.
export class DerivedDatasetError extends Error {
  override name = 'DerivedDatasetError';
  readonly dataset: string;

  constructor(dataset: string, cause: unknown) {
    super(`Derived dataset ${dataset} failed: ${errorMessage(cause)}`, {
      cause,
    });
    this.dataset = dataset;
  }
}

// Data a pipeline keeps in step with what its copies load, and can always
// rebuild from it (Kleppmann's derived data; Estuary's derivations), such as a
// view over loaded tables or the text of the files a copy stored. Each kind
// owns how it makes its data; the pipeline owns when: in the background after
// each commit of a copy, after each pass of a watch, and after the passes of a
// run. A refresh can run while a copy loads, so it reads only what committed.
export abstract class DerivedDataset<Target extends DestinationTarget> {
  abstract readonly name: string;

  // Refuses, without I/O, a declaration the pipeline's copies cannot feed.
  validate(_connections: readonly Connection<Target>[]): void {}

  // Brings the data in step with what the copies committed; safe to repeat.
  // A failure here is the dataset's own, such as SQL its store refuses; a
  // rule that fails on one input records that on the input's row instead.
  // earlier holds the derived datasets that this refresh follows, in their
  // declared order, so a dataset that reads one of them can tell an input
  // that is still waiting from one the pipeline never makes. trigger says why
  // the pipeline refreshes.
  abstract refresh(options: {
    readonly connections: readonly Connection<Target>[];
    readonly earlier: readonly DerivedDataset<Target>[];
    readonly signal?: AbortSignal;
    readonly trigger: RefreshTrigger;
  }): Promise<void>;
}
