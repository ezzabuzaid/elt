# The chunks of a text tile it

Status: accepted by Ezz (2026-11-24, #5399): "Go with all four (Recommended)". This answer approved item 1 of four: "the passage contract requires that the passages of one source tile it: white space kept, overlap allowed, no gap (Haystack's splitter keeps white space for this reason)". The scope, one behaviour for each host and no option, is the decision of the main session of S9 (#5401), not his words. It comes from his rules (no flags) and from the leaders below.

The passage contract of `@zukhruf/retrieval` requires that the passages of a source tile it (ADR 0001 of retrieval, the amendment of 2026-11-24). `ContextWindow` merges the passages of a window by their offsets, in code points. When a passage starts after the end of the passages before it, the merge fails with `PassageGapError` (ADR 0008 of retrieval). The Vectorizer of elt (#5401) writes the chunks of `Chunking` as passages. Until this decision, a chunk had no white space at its start or its end ([ADR 0003](./0003-a-chunk-ends-at-the-largest-boundary-that-fits.md)), so the white space between two chunks was in no chunk. Each such place is a gap.

The leaders do not agree (read on 2026-11-24):

| Leader                                                                                                        | White space                                                                                | Offsets                                                                                      |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| LangChain Python `TextSplitter` (langchain-ai/langchain@fb10639a, `langchain_text_splitters/base.py` 70, 164) | Removed at the start and the end, by default. The option `strip_whitespace=False` keeps it | `add_start_index` finds each chunk with `text.find` (line 140), so the chunks can leave gaps |
| LangChain JS `TextSplitter` (langchain-ai/langchainjs@a22d0d0c, `text_splitter.ts` 179)                       | Always removed: `docs.join(separator).trim()`. No option                                   | `loc.lines` from `indexOf` (line 102)                                                        |
| LlamaIndex `SentenceSplitter` (run-llama/llama_index@99d7433f, `node_parser/text/sentence.py` 320-330)        | Always removed, and a chunk of only white space is dropped                                 | `start_char_idx` from `text.find` (`node_parser/interface.py` 110)                           |
| Haystack `DocumentSplitter` (deepset-ai/haystack@737b457a, `preprocessors/document_splitter.py` 383-458)      | Kept. Only a split of length 0 is skipped, so a split of only white space stays            | `split_idx_start`: the place of the split in the source                                      |
| Chonkie `RecursiveChunker` (chonkie-inc/chonkie@664454b6, `chunker/recursive.py` 160-165)                     | Kept                                                                                       | `start_index`, and `end_index = start_index + len(text)`                                     |

Three leaders remove the white space, and two keep it. The offsets of the three that remove it come from a search for the chunk text, not from the cut, so their chunks do not tile the source. Only Haystack and Chonkie give offsets that are slices of the source, and both keep the white space as their one behaviour. Four of the five leaders have no option.

## Decision

- A chunk is the slice of the input from the start of its first piece to the end of its last piece. It keeps all its white space. Each piece keeps its separator, so the end of the last piece is the start of the next piece, or the end of the input.
- The first chunk starts at offset 0. The last chunk ends at the length of the input in code points. Each chunk starts at or before the end of the chunk before it: an overlap is allowed, and a gap is not.
- The rule counts the text that it keeps, white space included. Thus the limit of [ADR 0002](./0002-the-host-s-tokenizer-measures-each-chunk-and-no-chunk-passes-the-limit.md) holds on the text that the parts table stores, and `tokens` is the count of that text. The overlap also counts its white space.
- A run of white space that does not fit beside the text around it is a chunk of its own. It holds only white space, and the rule writes it, because the chunks leave a gap without it. Haystack and Chonkie also keep such a split.
- A text of only white space gives no chunk. `read()` gives no input for a row whose fields hold only white space, as before.
- `Chunking` has this one behaviour for each host. It has no option.

## Considered Options

- **Remove the white space of each chunk, as LangChain and LlamaIndex do.** The passages leave gaps, and `ContextWindow` fails with `PassageGapError`.
- **An option that keeps the white space, as LangChain Python's `strip_whitespace=False`.** A host that keeps the default cannot write the passage contract. The option makes a state that is not legal for the Vectorizer, and the owner's rule is no flags.
- **Keep the white space, but drop a chunk of only white space, as LlamaIndex drops one.** The place of the dropped chunk is a gap.
- **Keep all the white space, with one behaviour, as Haystack and Chonkie do.** This option was selected.

## Consequences

- The rule identity has the package version ([ADR 0005](./0005-the-rule-identity-of-a-chunk-is-the-package-version-the-tokenizer-and-the-two-sizes.md)). Thus the first release with this decision cuts each text again, one time, in each host. Most chunk texts change, because they now hold the white space at their end. Their part hashes change, and the embedding makes their vectors again one time.
- The parts merged by their offsets give back the input that `read()` gives: `ContextWindow` and a reader in SQL get the exact text between the first `start` and the last `end`.
- A chunk text can start or end with spaces or line breaks. A reader that shows a chunk can remove them for the display.
- White space counts tokens. A text with much white space gives more chunks than before.
- A chunk of only white space gets a vector that tells nothing. Such a chunk occurs only when a run of white space does not fit beside the text around it.
- ADR 0003 is superseded in part: its sentences on the white space of a chunk.

Sources: #5401, #5399 (the passage contract of `@zukhruf/retrieval`).
