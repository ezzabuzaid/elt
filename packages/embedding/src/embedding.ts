import { UnitVector, Vector, ZeroVectorError } from '@zukhruf/vectors';
import { APICallError, type EmbeddingModel, embedMany } from 'ai';

import {
  type LoadedRow,
  type PipelineClock,
  Rule,
  type RuleColumn,
  type RuleResult,
  type RuleValues,
  errorMessage,
  rowText,
} from '@eltjs/elt';

type Columns = { readonly vector: Extract<RuleColumn, { type: 'vector' }> };

// How long one call has, its retries included. The AI SDK gives a call no limit,
// and a model server that never answers takes 3 tries of undici's 300 s header
// timeout, about 15 minutes for each batch. This is far above a batch of 64
// short texts on a local model server, and it fails the rows of that batch: the
// next refresh asks again.
const callLimitMs = 120_000;

// The vector of each loaded row's text, made by an embedding model, so a
// vector search finds rows by meaning, as pgai's vectorizer and LanceDB's
// embedding functions keep one beside each row. A vector is a unit vector of
// float32 values, which @zukhruf/embeddings' VectorSearch reads (its ADR
// 0005): cosine similarity is then a dot product.
export class Embedding extends Rule<string, Columns> {
  override readonly key: {
    readonly name: string;
    readonly description: string;
  };
  override readonly output: Columns;
  // Rows embedded and committed together; the model's own limit on values in
  // one call splits a batch further inside embedMany.
  override readonly batch = 64;
  // One call at a time: a local model server answers one call at a time.
  override readonly concurrency = 1;
  readonly #model: EmbeddingModel;
  readonly #clock: Pick<PipelineClock, 'setTimeout' | 'clearTimeout'>;
  readonly #fields: readonly string[];

  // dimensions: how many values each vector of the model has, such as 1536
  // for text-embedding-3-small. key: the column that identifies a row, such
  // as id. fields: the columns whose text makes the vector, joined by line
  // breaks; a row with none has no vector. clock waits out the limit of each
  // call (ADR 0019 of elt): an app gives globalThis.
  constructor({
    model,
    dimensions,
    clock,
    key,
    fields,
  }: {
    model: EmbeddingModel;
    dimensions: number;
    clock: Pick<PipelineClock, 'setTimeout' | 'clearTimeout'>;
    key: string;
    fields: readonly string[];
  }) {
    super();
    this.#model = model;
    this.output = {
      vector: {
        type: 'vector',
        dimensions,
        description: `The unit vector of the row text, ${dimensions} float32 values. NULL unless status is computed.`,
      },
    };
    this.#clock = clock;
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
    const text = rowText(row, this.#fields);
    return text === null ? null : { key: String(key), input: text };
  }

  // The model and the dimensions make every vector, so they name them all:
  // one model can give vectors of several sizes, as OpenAI's
  // text-embedding-3 models do.
  override async identity(): Promise<string> {
    const model =
      typeof this.#model === 'string'
        ? this.#model
        : `${this.#model.provider}/${this.#model.modelId}`;
    return `${model} (${this.output.vector.dimensions} dimensions)`;
  }

  override async compute(
    texts: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly RuleResult<RuleValues<Columns>>[]> {
    const limit = new AbortController();
    const timer = this.#clock.setTimeout(() => limit.abort(), callLimitMs);
    try {
      const { embeddings } = await embedMany({
        model: this.#model,
        values: [...texts],
        abortSignal:
          signal === undefined
            ? limit.signal
            : AbortSignal.any([signal, limit.signal]),
      });
      return embeddings.map(unitVector);
    } catch (failure) {
      if (signal?.aborted) return texts.map(() => ({ gone: true }));
      if (limit.signal.aborted) {
        const error = `The model did not answer within ${callLimitMs / 1000} s.`;
        return texts.map(() => ({ error }));
      }
      // A 400 refuses something in the call, such as a text over the model's
      // limit. Halves of the call find the input it refuses, so that failure
      // stays on its own row. Any other failure says nothing about the texts,
      // and a split would only send more calls to a model that is down.
      if (
        texts.length > 1 &&
        APICallError.isInstance(failure) &&
        failure.statusCode === 400
      ) {
        const half = Math.ceil(texts.length / 2);
        return [
          ...(await this.compute(texts.slice(0, half), signal)),
          ...(await this.compute(texts.slice(half), signal)),
        ];
      }
      // A model that refuses a call fails each row of it; the next refresh
      // asks again.
      const error = errorMessage(failure);
      return texts.map(() => ({ error }));
    } finally {
      this.#clock.clearTimeout(timer);
    }
  }
}

// A vector with no usable length has no unit vector: an all-zero vector
// has no direction, and a value that is not finite would rank in a search as
// an answer. The row fails, and the next refresh asks again.
function unitVector(
  embedding: readonly number[],
): RuleResult<RuleValues<Columns>> {
  try {
    return { value: { vector: UnitVector.normalize(Vector.from(embedding)) } };
  } catch (failure) {
    if (!(failure instanceof ZeroVectorError || failure instanceof RangeError))
      throw failure;
    return {
      error: `The model answered a vector of length ${Math.hypot(...embedding)}.`,
    };
  }
}
