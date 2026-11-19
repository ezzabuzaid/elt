# Chunking

> **Design on paper, accepted by Ezz on 2026-11-19.** Backlog #4737. The terms Table rule, Part, Part hash and Place column go into the glossary of [elt](../elt/CONTEXT.md) when [ADR 0026 of elt](../elt/docs/adr/0026-a-rule-can-give-many-parts-for-one-input.md) is built.

An embedding model has a limit of tokens for each text, and one vector of a long text loses the meaning of its parts. A host wants each long text that a pipeline loads cut into chunks that the model takes, so that a search finds the part of a document that matches. `Chunking` is the rule of a computed dataset that cuts each text. The words that all of elt uses, for example rule, key, input and output, are in the glossary of [elt](../elt/CONTEXT.md).

## Language

**Chunk**:
A part of a text that `Chunking` gives: a slice of the text, with no white space at the start or the end, that counts at most `maxTokens` tokens.
_Avoid_: Node (LlamaIndex), split (Haystack), passage (datahub's staff search makes a passage from a record, not from a cut), segment (a segment is what `Intl.Segmenter` gives)

**Token**:
The unit that the tokenizer of a model counts. The limit of a model is in tokens, for example 8,191 for OpenAI's `text-embedding-3-small`.
_Avoid_: Word, character

**Tokenizer**:
What the host gives to count tokens: a name of the vocabulary, for example `cl100k_base`, and `count(text)`. It must be the tokenizer of the embedding model.
_Avoid_: Encoder, encoding (an encoding is one vocabulary of tiktoken), length function

**Vocabulary**:
The tokens that one tokenizer knows, for example `cl100k_base` or `o200k_base`. Its name is part of the rule identity.
_Avoid_: Encoding, model

**Fit**:
A chunk fits when `count` of its own text is at most `maxTokens`. The rule counts the text of the chunk, not the sum of its pieces, because a tokenizer can count two joined pieces as more tokens than the two pieces.
_Avoid_: Size check, estimate

**Boundary**:
A place where the rule can end a chunk. From the largest to the smallest: a paragraph, a line, a sentence, a word, a grapheme.
_Avoid_: Separator (a separator is text; a boundary is a place), delimiter

**Piece**:
The text between two boundaries of one kind. The rule packs pieces into chunks.
_Avoid_: Split, segment, unit

**Grapheme**:
What a reader sees as one character, for example `é` written as `e` and a combining accent. The rule never cuts inside a grapheme.
_Avoid_: Character (a JavaScript character is a UTF-16 unit), code point

**Overlap**:
The last whole pieces of a chunk, up to `overlapTokens` tokens, that the next chunk starts with, so that a sentence at a cut is in both chunks.
_Avoid_: Stride, window

**Table rule** (elt):
A rule that gives an ordered list of parts for one input, as a SQL table function gives rows. `Chunking` is one.
_Avoid_: Splitter, expander, flat map

**Part** (elt):
One item of the list that a table rule gives for one input. The computed dataset keeps it in `<name>_parts`, with its key and its `seq`.
_Avoid_: Row (the dataset keeps a part in a row), child, element

**Part hash** (elt):
The SHA-256 of the content columns of one part. It does not cover `seq` or the place columns. Two parts with the same text have the same part hash, so a dataset that reads parts can key them by content.
_Avoid_: Input hash (an output row keeps the input hash), row hash (the row hash covers the key and `seq` too), chunk id

**Place column** (elt):
A column of a part that tells where the part is in its input, such as `start` and `end` of a chunk. The parts table keeps it, but the part hash does not cover it, so a part that only moved keeps its part hash.
_Avoid_: Position (a position is a place in the commits of a destination), metadata

**Offset**:
The count of code points before a place in the text that `read()` gives. `start` is the offset of the first code point of a chunk; `end` is the offset after its last one.
_Avoid_: Index, character index (a JavaScript string counts UTF-16 units)
