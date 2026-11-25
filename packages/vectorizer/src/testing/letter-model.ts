import type {
  EmbeddingModelV4,
  EmbeddingModelV4CallOptions,
  EmbeddingModelV4Result,
} from '@ai-sdk/provider';

// Copied from packages/embedding/src/embedding.test.ts, one place in each
// package (docs/copied-test-helpers.md): a real EmbeddingModelV4 whose vector
// of a text counts each letter a to z.
export class LetterModel implements EmbeddingModelV4 {
  readonly specificationVersion = 'v4';
  readonly provider = 'test';
  readonly modelId: string;
  readonly maxEmbeddingsPerCall = undefined;
  readonly supportsParallelCalls = true;
  readonly embedded: string[] = [];
  // What the model answers for a text, in place of counting its letters.
  readonly answers = new Map<string, number[]>();
  // A call of these values never answers, until its signal aborts it.
  hangs: (values: readonly string[]) => boolean = () => false;

  constructor(modelId = 'letters') {
    this.modelId = modelId;
  }

  async doEmbed({
    values,
    abortSignal,
  }: EmbeddingModelV4CallOptions): Promise<EmbeddingModelV4Result> {
    if (this.hangs(values))
      await new Promise((_, reject) =>
        abortSignal?.addEventListener('abort', () =>
          reject(abortSignal.reason),
        ),
      );
    this.embedded.push(...values);
    return {
      embeddings: values.map((text) => this.answers.get(text) ?? letters(text)),
      warnings: [],
    };
  }
}

const letters = (text: string) =>
  Array.from(
    { length: 26 },
    (_, index) =>
      [...text.toLowerCase()].filter(
        (letter) => letter.charCodeAt(0) - 97 === index,
      ).length,
  );
