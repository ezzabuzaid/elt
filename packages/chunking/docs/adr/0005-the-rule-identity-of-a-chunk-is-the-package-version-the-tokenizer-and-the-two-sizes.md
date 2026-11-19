# The rule identity of a chunk is the package version, the tokenizer and the two sizes

Status: accepted by Ezz (2026-11-19).

A computed dataset makes an output again when its rule identity changes ([ADR 0005 of elt](../../../elt/docs/adr/0005-an-output-is-made-again-when-its-rule-identity-changes.md)). The chunks of a text change when the vocabulary changes, when a size changes, or when the code that cuts changes. ADR 0005 of elt rejects a version number that a person increases, because a person forgets it.

Thus the rule identity is `@eltjs/chunking@<version> <tokenizer.name> <maxTokens>/<overlapTokens>`, for example `@eltjs/chunking@0.5.0 cl100k_base 800/400`. The version comes from the `package.json` of the package, which the release sets. It is the same for each input.

Each release of the package cuts each text again. This is cheap: cutting is local work of milliseconds for each document, and the model is paid only for chunk texts that changed. A part with the same values keeps its commit ([ADR 0026 of elt](../../../elt/docs/adr/0026-a-rule-can-give-many-parts-for-one-input.md)), and the embedding keys each chunk by its part hash ([ADR 0027 of elt](../../../elt/docs/adr/0027-a-dataset-reads-the-parts-of-a-computed-dataset-through-a-view.md)), so a chunk whose text did not change keeps its vector.

## Considered Options

- **A version of the algorithm that a person increases.** A person forgets it, and the chunks of an old cut then stay.
- **The tokenizer and the sizes only.** A change of the code that cuts leaves the old chunks.
- **The package version, the tokenizer and the sizes.** This option was selected.

## Consequences

- A release that does not change the cut still cuts each text again, and writes nothing new.
- The tokenizer's name must change when its vocabulary changes. The host gives the name, so a host that gives a wrong name keeps old chunks.

Sources: #4737.
