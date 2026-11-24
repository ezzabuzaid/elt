# A chunk ends at the largest boundary that fits

Status: accepted by Ezz (2026-11-19).

Superseded in part on 2026-11-24 (#5401) by [ADR 0007](./0007-the-chunks-of-a-text-tile-it.md): a chunk keeps the white space at its start and its end, and a chunk of only white space between two others is written, so the chunks of a text tile it. Before, the rule removed that white space, as LangChain and LlamaIndex do, and dropped a chunk of only white space.

A chunk that ends inside a sentence gives a vector of half a thought. A chunk that ends inside a character corrupts the text. The leaders cut recursively: they try the largest boundary first, and they split again only the pieces that do not fit.

| Leader                                     | Boundaries, from the largest                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| LangChain `RecursiveCharacterTextSplitter` | `"\n\n"`, `"\n"`, `" "`, `""`. No sentence                                                 |
| pgai recursive splitter                    | `"\n\n"`, `"\n"`, `"."`, `"?"`, `"!"`, `" "`, `""`. A `.` also cuts `3.5`                  |
| LlamaIndex `SentenceSplitter`              | `"\n\n\n"`, NLTK punkt sentences, the regex `[^,.;。？！]+[,.;。？！]?`, `" "`, characters |
| Unstructured                               | the elements of a document: a title, a paragraph, a table                                  |

Thus the rule cuts at five boundaries, from the largest: a paragraph (two or more line breaks), a line break, a sentence, a word, and a grapheme. The sentence, the word and the grapheme come from `Intl.Segmenter`, which applies Unicode text segmentation ([UAX #29](https://unicode.org/reports/tr29/)) for each script, with no dependency and no network. A text that fits is one chunk. Else the rule splits it into pieces at the largest boundary, splits each piece that does not fit at the next boundary, and packs the pieces in order: a piece joins the chunk while the chunk fits ([ADR 0002](./0002-the-host-s-tokenizer-measures-each-chunk-and-no-chunk-passes-the-limit.md)).

Each piece keeps its separator, so the pieces of a text join back into the text. A chunk is the slice of the input from the start of its first piece to the end of its last piece, with all its white space, so the chunks tile the text ([ADR 0007](./0007-the-chunks-of-a-text-tile-it.md)). A chunk of only white space between two others is written too. A grapheme that alone does not fit is a rule failure of its input, with its offset in the error.

## Considered Options

- **LangChain's separators.** With no sentence boundary, a long paragraph is cut at the first space that fits. In a probe of 2026-11-19, 67 of 88 chunks started inside a sentence.
- **Punctuation as separators, as pgai.** `.` cuts numbers, versions and abbreviations.
- **NLTK punkt, as LlamaIndex.** JavaScript has no port of punkt in the standard library, and a model of abbreviations is a dependency for each language.
- **Elements of the document, as Unstructured.** A `DocumentParser` gives plain text, with no titles or tables. This waits for a parser that gives structure.
- **Unicode text segmentation through `Intl.Segmenter`.** This option was selected.

## Consequences

- No chunk ends inside a grapheme, so a chunk never holds U+FFFD from a cut.
- `Intl.Segmenter` ends a sentence after some abbreviations: `"Dr. Smith went home."` gives `"Dr. "` and `"Smith went home."` (probe, Node 26.13.0). The packing joins such pieces again while the chunk fits, so only the place of a cut can move.
- The same text, tokenizer and sizes always give the same chunks.
- Sentence rules can differ by locale. The rule uses the root locale; a `locale` option waits for a host that needs one.

Sources: #4737.
