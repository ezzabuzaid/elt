import { type EmbeddingModel, embedMany } from 'ai';

import { type LoadedRow, Rule, type RuleResult } from '@workspace/elt';

// The vector of each loaded row's text, made by an embedding model, so a
// vector search finds rows by meaning, as pgai's vectorizer and LanceDB's
// embedding functions keep one beside each row. A vector is stored as a unit
// vector of float32 values in the platform's byte order, the form
// @zukhruf/embeddings' VectorSearch reads (its ADR 0005): cosine similarity
// is then a dot product.
export class Embedding extends Rule<string, Uint8Array> {
  override readonly key: {
    readonly name: string;
    readonly description: string;
  };
  override readonly output = {
    vector: {
      type: 'blob',
      description:
        'The unit vector of the row text, float32 values in the byte order of the platform. NULL unless status is computed.',
    },
  } as const;
  // Rows embedded and committed together; the model's own limit on values in
  // one call splits a batch further inside embedMany.
  override readonly batch = 64;
  readonly #model: EmbeddingModel;
  readonly #fields: readonly string[];

  // key: the column that identifies a row, such as id. fields: the columns
  // whose text makes the vector, joined by line breaks; a row with none has
  // no vector.
  constructor({
    model,
    key,
    fields,
  }: {
    model: EmbeddingModel;
    key: string;
    fields: readonly string[];
  }) {
    super();
    this.#model = model;
    this.key = {
      name: key,
      description: `The ${key} of the row the vector is made from.`,
    };
    this.#fields = Object.freeze([...fields]);
    Object.freeze(this);
  }

  override read(
    row: LoadedRow,
  ): { readonly key: string; readonly input: string } | null {
    const key = row[this.key.name];
    if (typeof key !== 'string' && typeof key !== 'number') return null;
    const text = this.#fields
      .map((field) => row[field])
      .filter((value) => typeof value === 'string' && value.trim() !== '')
      .join('\n');
    return text === '' ? null : { key: String(key), input: text };
  }

  // The model makes every vector, so its provider and id name them all.
  override async identity(): Promise<string> {
    return typeof this.#model === 'string'
      ? this.#model
      : `${this.#model.provider}/${this.#model.modelId}`;
  }

  override async compute(
    texts: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly RuleResult<Readonly<Record<string, Uint8Array>>>[]> {
    try {
      const { embeddings } = await embedMany({
        model: this.#model,
        values: [...texts],
        abortSignal: signal,
      });
      return embeddings.map((embedding) => ({
        value: { vector: unitVector(embedding) },
      }));
    } catch (failure) {
      if (signal?.aborted) return texts.map(() => ({ gone: true }));
      // A model that refuses a call fails each row of it; the next refresh
      // asks again.
      const error =
        failure instanceof Error ? failure.message : String(failure);
      return texts.map(() => ({ error }));
    }
  }
}

function unitVector(embedding: readonly number[]): Uint8Array {
  const length = Math.hypot(...embedding);
  return new Uint8Array(
    Float32Array.from(embedding, (value) => value / length).buffer,
  );
}
