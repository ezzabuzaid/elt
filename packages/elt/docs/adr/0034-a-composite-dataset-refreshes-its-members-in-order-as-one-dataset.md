# A composite dataset refreshes its members in order as one dataset

A vectorizer of `@eltjs/vectorizer` declares many derived datasets for one job: the chunks of each source row, a keyword index, the passages, the vectors and a status view (elt #5401). A host must not declare each of them by hand. Each one reads the one before it, and a host that forgets one, or puts two in the wrong order, gets passages with no vectors. pgai's `create_vectorizer` is one call for the same job, and LlamaIndex's `IngestionPipeline` is one object.

The pipeline knew only one kind of declaration, a `DerivedDataset`, which has its own `refresh`. Three rules of the pipeline must see each part of a vectorizer:

- **Distinct names.** Each part has its own relations. A host view of the same name as a part would replace it.
- **`earlier`.** A `View` of each destination reads `earlier` to know which relations it waits for. A host view after the vectorizer that reads its passages must find the passages there, or it fails in place of waiting.
- **The bulkhead of ADR 0031.** A failure of one part must not stop the copies or the other datasets of the pipeline.

## Decision

For #5401, Ezz ruled on 2026-11-24 that the vectorizer is one composite of the kinds of derived dataset that exist, with a keyword index as a new kind. `CompositeDataset` is a second kind of declaration in `@eltjs/elt`, beside `DerivedDataset`. `Pipeline` takes `derived?: readonly DeclaredDataset[]`, and `DeclaredDataset` is `DerivedDataset | CompositeDataset`.

```ts
export abstract class CompositeDataset<Target extends DestinationTarget> {
  abstract readonly name: string;
  // In refresh order; each member reads only members before it.
  abstract readonly members: readonly [
    DerivedDataset<Target>,
    ...DerivedDataset<Target>[],
  ];
  validate(_connections: readonly Connection<Target>[]): void {}
}
```

- A composite is not a `DerivedDataset`. It has no `refresh`, so no code can refresh it as one dataset, and `earlier` cannot hold it.
- Its members are derived datasets only. A member cannot be a composite. The list of members cannot be empty.
- `Pipeline.derived` gives the members of each composite in its place, in refresh order. Its type stays `readonly DerivedDataset[]`.
- The check of distinct names counts the name of each composite and the name of each of its members. A failure names the composite, so its name must be distinct too.
- The pipeline validates the composite, and then each of its members, before any connection reads.
- `earlier` holds every member declared before, failed or not, as it held every dataset declared before.
- A composite is one dataset of the bulkhead:
  - The members refresh in order. The first member that fails stops the members after it in that refresh, so no member reads what the failed member left stale (paper D3 of #5401). The refresh after the next pass tries the composite again from its first member.
  - The commit refreshes skip a composite whose last refresh failed, as they skip a failed dataset.
  - Each member keeps its own row in `derived_status` (ADR 0025), and its own keys of the commit refreshes (`tried`).
- The error of a failed composite names the member: it is `new DerivedDatasetError(member, cause)`. A watch gives `{ kind: 'refresh', dataset: <composite>, error: DerivedDatasetError(<member>, cause) }`, and a run rejects with `DerivedDatasetError(<composite>, DerivedDatasetError(<member>, cause))`. ADR 0031 says that the event does not wrap the error of a dataset. A composite must say which member failed, so it wraps its member's error once.

## Considered Options

- **The composite is a `DerivedDataset` whose `refresh` calls its members.** The pipeline then sees one name and one dataset. A host view that reads a member does not find it in `earlier`, the check of distinct names does not see the members, and each `View` would need to look inside a composite.
- **The host declares each member.** This needs no change to the pipeline. Each host then writes the order and the names of a vectorizer again, and a mistake in them is silent until a search finds nothing.
- **A failed member does not stop the members after it.** The keyword index and the vectors would then read passages that the failed member did not bring in step.
- **Members can be composites.** No host nests composites. The type keeps one level.
