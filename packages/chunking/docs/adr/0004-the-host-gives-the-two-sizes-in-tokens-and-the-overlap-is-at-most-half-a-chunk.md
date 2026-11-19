# The host gives the two sizes in tokens, and the overlap is at most half a chunk

Status: accepted by Ezz (2026-11-19).

The leaders do not agree on a size of a chunk or of its overlap:

| Leader                         | Size                      | Overlap        | Limit of the overlap               |
| ------------------------------ | ------------------------- | -------------- | ---------------------------------- |
| LangChain                      | 1,000 characters          | 200            | below the size                     |
| LlamaIndex `SentenceSplitter`  | 1,024 tokens              | 200 tokens     | not above the size                 |
| pgai                           | 800 characters            | 400 characters | below the size (LangChain's check) |
| OpenAI file search             | 800 tokens (100 to 4,096) | 400 tokens     | at most half of the size           |
| .NET `IngestionChunkerOptions` | 2,000 tokens              | 500 tokens     | below the size                     |
| Haystack `DocumentSplitter`    | 200 words                 | 0              | below the size                     |
| Unstructured                   | 500 characters            | 0              | below the size                     |
| datahub's vector store today   | 4,096 tokens              | 1,365 tokens   | (OpenAI's)                         |

The right size depends on the model and on what the search must find. Thus `maxTokens` and `overlapTokens` are required, with no default. Both count tokens of the host's tokenizer, as OpenAI, LlamaIndex and .NET name the unit.

The overlap is at most half of `maxTokens`, as OpenAI requires. An overlap of more than half makes most of each chunk a copy of the chunk before it, and pays the model for the same text twice. The constructor refuses a `maxTokens` below 1, an `overlapTokens` below 0, and an `overlapTokens` above half of `maxTokens`, with a `RangeError` that names the value.

The overlap is made of whole pieces, as LangChain's `mergeSplits` keeps the last pieces of a chunk while they count at most the overlap. Each chunk starts after the start of the chunk before it, so the rule always ends.

## Considered Options

- **Defaults from one leader.** The leaders range from 200 words to 2,000 tokens, and a default hides a choice that the host must make for its model.
- **Overlap below the size, as LangChain and .NET.** An overlap of 90% is then legal, and costs nearly twice the calls.
- **Overlap of a fixed number of tokens that can cut a piece.** The next chunk then starts inside a word.
- **Required sizes in tokens, and an overlap of whole pieces of at most half a chunk.** This option was selected.

## Consequences

- Each host states its sizes. The README example uses OpenAI's file search defaults, 800 and 400, for `text-embedding-3-small`.
- An overlap can count fewer tokens than `overlapTokens`, because it holds only whole pieces.

Sources: #4737.
