import type { Connection } from './connection.ts';
import type { Target as DestinationTarget } from './target.ts';

// Data a pipeline keeps in step with what its copies load, and can always
// rebuild from it (Kleppmann's derived data; Estuary's derivations), such as a
// view over loaded tables or the text of the files a copy stored. Each kind
// owns how it makes its data; the pipeline owns when: after the passes of a
// run, and after each pass of a watch.
export abstract class DerivedDataset<Target extends DestinationTarget> {
  abstract readonly name: string;

  // Refuses, without I/O, a declaration the pipeline's copies cannot feed.
  validate(_connections: readonly Connection<Target>[]): void {}

  // Brings the data in step with what the copies committed; safe to repeat.
  // A failure here is the dataset's own, such as SQL its store refuses; a
  // rule that fails on one input records that on the input's row instead.
  // earlier holds the derived datasets that this refresh follows, in their
  // declared order, so a dataset that reads one of them can tell an input
  // that is still waiting from one the pipeline never makes.
  abstract refresh(options: {
    readonly connections: readonly Connection<Target>[];
    readonly earlier: readonly DerivedDataset<Target>[];
    readonly signal?: AbortSignal;
  }): Promise<void>;
}
