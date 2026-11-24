import type { EmbeddingModel } from 'ai';

import type { Tokenizer } from '@eltjs/chunking';
import type { DocumentParser, FileStorage, PipelineClock } from '@eltjs/elt';

// The key of a source row: one column, whose plain value is Passage.source,
// or two or more, whose values in a JSON array are. One column is the string
// form only, so no list of one column can encode a source in two ways.
export type SourceKey = string | readonly [string, string, ...string[]];

// What text of a source row the passages cut: the text of its columns,
// joined with line breaks (pgai loading_column, Airbyte text_fields), or the
// text of the stored file that one column names (pgai loading_uri).
export type Loading =
  | { readonly columns: readonly [string, ...string[]] }
  | {
      readonly file: string;
      readonly files: FileStorage;
      readonly parser: () => DocumentParser;
    };

// The sizes of @eltjs/chunking, or one passage for each row (pgai
// chunking_none).
export type ChunkingOptions =
  | {
      readonly tokenizer: Tokenizer;
      readonly maxTokens: number;
      readonly overlapTokens: number;
    }
  | 'none';

// The options of @eltjs/embedding without its key and fields, which the
// vectorizer sets.
export type EmbeddingOptions = {
  readonly model: EmbeddingModel;
  readonly dimensions: number;
  readonly clock: Pick<PipelineClock, 'setTimeout' | 'clearTimeout'>;
};

// The columns of the key, in order.
export function keyColumns(key: SourceKey): readonly [string, ...string[]] {
  return typeof key === 'string' ? [key] : key;
}

// Refuses a key column listed twice, a metadata column listed twice, and a
// metadata column that has the name of a column of the contract, which it
// would replace. Names compare as the engine compares them: in ASCII case.
export function refuseColumns({
  vectorizer,
  key,
  metadata,
  contract,
}: {
  readonly vectorizer: string;
  readonly key: SourceKey;
  readonly metadata: readonly string[];
  readonly contract: readonly string[];
}): void {
  const fold = (name: string) =>
    name.replaceAll(/[A-Z]/g, (letter) => letter.toLowerCase());
  const repeated = (names: readonly string[]) =>
    names.find((name, index) =>
      names.slice(0, index).some((before) => fold(before) === fold(name)),
    );
  const repeatedKey = repeated(keyColumns(key));
  if (repeatedKey !== undefined)
    throw new TypeError(
      `Vectorizer ${vectorizer} lists the key column ${repeatedKey} twice`,
    );
  const repeatedMetadata = repeated(metadata);
  if (repeatedMetadata !== undefined)
    throw new TypeError(
      `Vectorizer ${vectorizer} lists the metadata column ${repeatedMetadata} twice`,
    );
  const taken = metadata.find((name) =>
    contract.some((column) => fold(column) === fold(name)),
  );
  if (taken !== undefined)
    throw new TypeError(
      `Vectorizer ${vectorizer} cannot give the metadata column ${taken}: the passages have a column of that name (${contract.join(', ')})`,
    );
}
