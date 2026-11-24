# Chunking

An embedding model has a limit of tokens for each text, and one vector of a long text loses the meaning of its parts. A host wants each long text that a pipeline loads cut into chunks that the model takes, so that a search finds the part of a document that matches. `Chunking` is the rule of a computed dataset that cuts each text. The words that all of elt uses, for example rule, key, input, output, table rule, part, part hash and place column, are in the glossary of [elt](../elt/CONTEXT.md).

## Language

**Chunk**:
A part of a text that `Chunking` gives: a slice of the text, with all its white space, that counts at most `maxTokens` tokens. The chunks of a text tile it.
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

**Tile**:
The chunks of a text tile it when they cover each code point of the text: the first chunk starts at offset 0, the last ends at the length of the text, and no chunk starts after the end of the chunk before it. Chunks can overlap. The passage contract of `@zukhruf/retrieval` requires it.
_Avoid_: Cover, partition (the chunks of a partition do not overlap)

**Offset**:
The count of code points before a place in the text that `read()` gives. `start` is the offset of the first code point of a chunk; `end` is the offset after its last one.
_Avoid_: Index, character index (a JavaScript string counts UTF-16 units)
