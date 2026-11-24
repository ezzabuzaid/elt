import type { Connection } from './connection.ts';
import type { DerivedDataset } from './derived-dataset.ts';
import type { Target as DestinationTarget } from './target.ts';

// Derived datasets that one declaration makes, such as the passages, vectors
// and keyword index of a vectorizer, which the pipeline refreshes in order as
// one dataset: a member's failure fails the composite, and the members after
// it wait for the next refresh, so none reads what the failed member left
// stale (ADR 0034). A composite has no refresh of its own, so it is never in
// the earlier datasets of a refresh: its members are.
export abstract class CompositeDataset<Target extends DestinationTarget> {
  abstract readonly name: string;
  // In refresh order; each member reads only members before it.
  abstract readonly members: readonly [
    DerivedDataset<Target>,
    ...DerivedDataset<Target>[],
  ];

  // Refuses, without I/O, a declaration the pipeline's copies cannot feed.
  // The pipeline then validates each member.
  validate(_connections: readonly Connection<Target>[]): void {}
}

// What a pipeline declares as derived data: one dataset, or a composite.
export type DeclaredDataset<Target extends DestinationTarget> =
  DerivedDataset<Target> | CompositeDataset<Target>;

// The datasets that the pipeline refreshes for a declared dataset, in order.
export function declaredMembers<Target extends DestinationTarget>(
  dataset: DeclaredDataset<Target>,
): readonly [DerivedDataset<Target>, ...DerivedDataset<Target>[]] {
  return dataset instanceof CompositeDataset ? dataset.members : [dataset];
}
