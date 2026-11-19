# The host's tokenizer measures each chunk, and no chunk passes the limit

Status: accepted by Ezz (2026-11-19).

A model refuses a text over its limit of tokens. Only the tokenizer of that model can say how many tokens a text counts. Two models of the hosts of elt already use different tokenizers: OpenAI's `text-embedding-3-small` uses `cl100k_base` (`js-tiktoken` `getEncodingNameForModel`), and EmbeddingGemma, the local model of the `Embedding` README, uses the SentencePiece vocabulary of Gemma.

The leaders take the tokenizer from the caller. .NET `IngestionChunkerOptions(Tokenizer tokenizer)` requires an abstract `Tokenizer` of `Microsoft.ML.Tokenizers`. LlamaIndex `SentenceSplitter` takes a `tokenizer` callable. LangChain takes a `lengthFunction`. Unstructured and Haystack take a tiktoken name, so they serve only OpenAI's vocabularies.

Thus the host gives a `Tokenizer`: `{ name, count(text) }`. The package exports the type, and the host conforms (elt AGENTS.md, ports are typed by the package). For OpenAI's vocabularies, the README shows `gpt-tokenizer`: version 4.1.2 of 2026-11-10, no dependencies, each vocabulary bundled as its own subpath, no network. On 420,000 tokens it counted in 41 ms, and `js-tiktoken` 1.0.21 took 481 ms for the same count (probe, 2026-11-19, Node 26.13.0).

Each chunk fits: `count` of the text of the chunk is at most `maxTokens`. The rule counts the joined text, not the sum of its pieces. A tokenizer can count two joined pieces as more tokens than the two apart: in a probe of 3,000 random pairs of white space, accents and Japanese, 310 pairs counted more joined than apart in `cl100k_base` (for example `"é  "` and `"語"`). A sum can thus pass the limit.

The leaders that cut by tokens fail this in two ways, both probed on 2026-11-19:

- LangChain's `RecursiveCharacterTextSplitter` sums the lengths of pieces, and when a chunk is longer than the size it logs "Created a chunk of size …, which is longer than the specified …" and keeps it (`@langchain/textsplitters` 1.0.2, `text_splitter.js`).
- LangChain's `TokenTextSplitter` cuts the list of tokens and decodes each window. A token can hold part of a character, so 13 of 22 chunks of a text with accents, emoji and Japanese held U+FFFD. It also loads the vocabulary from `https://tiktoken.pages.dev` at run time (`@langchain/core/utils/tiktoken`).

## Considered Options

- **The package takes `gpt-tokenizer` and a vocabulary name, as Haystack and Unstructured do.** Only OpenAI's models are then served, and EmbeddingGemma counts wrong.
- **Count characters, and let the model refuse the chunks that do not fit, as pgai does.** pgai's embedder knows that `text-embedding-3-small` takes 8,191 tokens and records the error. A chunk then fails that a cut could have made fit.
- **Cut the list of tokens, as `TokenTextSplitter`.** A cut inside a character corrupts the text.
- **The host's tokenizer counts the text of each chunk.** This option was selected.

## Consequences

- No chunk that this rule gives passes `maxTokens` in the host's tokenizer. A model refusal is then a wrong tokenizer or a `maxTokens` above the model's limit.
- The package has no runtime dependency, and its tests can give a tokenizer that counts words, as a real stand-in.
- Each host of OpenAI's models writes the same two lines over `gpt-tokenizer`. A ready `Tokenizer` comes when a third host writes them.
- The cost is more calls of `count`: each time a piece joins a chunk, the rule counts the chunk. `gpt-tokenizer` counts about 10 million tokens a second, so a proposal of 50,000 tokens costs milliseconds.

Sources: #4737.
