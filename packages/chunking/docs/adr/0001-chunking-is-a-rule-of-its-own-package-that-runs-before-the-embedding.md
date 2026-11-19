# Chunking is a rule of its own package that runs before the embedding

Status: accepted by Ezz (2026-11-19).

The `Embedding` rule makes one vector for each loaded row. A SharePoint proposal can count more than 8,191 tokens, the limit of `text-embedding-3-small`. Then its row fails, and each pass tries it again. Datahub wants each proposal cut into chunks and each chunk embedded (backlog #4740). Ezz chose on 2026-11-19 to cut in the elt core, not in a SQL view that counts characters.

The leaders put the cut in two places:

- **A step of its own before the embedding.** LlamaIndex runs a node parser and then an embedding as two transformations of one `IngestionPipeline`. Haystack has `DocumentSplitter` and then an embedder component. .NET `Microsoft.Extensions.DataIngestion` has `IngestionChunker<T>`, and a writer embeds the chunks. Unstructured chunks the elements, and the embedding is a later step.
- **A setting of the embedding.** A pgai vectorizer takes `chunking => ai.chunking_recursive_character_text_splitter(…)` beside `embedding => …`, and keeps the chunk text and the vector in one row of its store.

Even pgai makes the chunker its own configuration object. The chunk text has value without its vector: datahub's staff search ranks by the best passage and plans BM25 over the same passages (#3426), and its passage view says "the search shows what it ranked". A chunker inside `Embedding` hides the chunk text, and a change of the chunk sizes would always pay the model again.

Thus `Chunking` is a rule of a computed dataset, and `Embedding` reads its chunks through a view ([ADR 0027 of elt](../../../elt/docs/adr/0027-a-dataset-reads-the-parts-of-a-computed-dataset-through-a-view.md)). It gives many parts for one input, which the elt core must allow first ([ADR 0026 of elt](../../../elt/docs/adr/0026-a-rule-can-give-many-parts-for-one-input.md)).

The rule lives in `packages/chunking`, `@eltjs/chunking`, with the tag `layer:island`. This mirrors `packages/embedding`, `@eltjs/embedding`: a rule whose domain is not elt's is its own package. pgai names the two settings `chunking` and `embedding`. .NET names the concept a chunker that gives chunks, and Go has no standard package; `langchaingo/textsplitter` copies LangChain.

## Considered Options

- **A chunker inside `Embedding`, as pgai.** The chunk text is not kept for readers or for BM25, and each change of the sizes pays the model for each chunk.
- **A rule in `packages/elt`, beside `DocumentText`.** `DocumentText` is in the core because `DocumentParser` is a core port. Tokens and boundaries are not elt concepts.
- **A package in zukhruf.** The cut itself is free of any domain. But this is the first place that writes it (strike 1): deepagents' retrieval takes LangChain's `MarkdownTextSplitter`, and datahub's vector store lets OpenAI cut. zukhruf's `packages/embeddings` says "There is no chunker … One vector for each chunk (MaxP) waits for a consumer that needs it" (`docs/copied-from-deepagents-retrieval.md`). The cut moves to zukhruf at strike 3.
- **Code in datahub.** Context Compiler embeds too (OpenSooq listings), and the design comes from the domain, not from one host.
- **A rule of its own package, before the embedding.** This option was selected.

## Consequences

- A host declares two computed datasets and two views for a chain from stored files to vectors (README, example).
- The chunk text is a column that readers can query, search with BM25, and show.
- The package has no runtime dependency. The host gives the tokenizer ([ADR 0002](./0002-the-host-s-tokenizer-measures-each-chunk-and-no-chunk-passes-the-limit.md)).

Sources: #4737, #4740, #3426.
