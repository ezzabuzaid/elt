import { homedir } from 'node:os';
import { join } from 'node:path';

import { CanaryModel } from './canary-model.ts';
import { CohereModel } from './cohere-model.ts';
import type { HandyModel } from './handy-model.ts';

// Handy owns these downloads; readers reuse them in place and never modify them.
export class HandyModels {
  readonly #directory: string;

  constructor(
    directory = join(
      homedir(),
      'Library/Application Support/com.pais.handy/models',
    ),
  ) {
    this.#directory = directory;
  }

  async list(): Promise<HandyModel[]> {
    const models = [
      new CohereModel(this.#directory),
      new CanaryModel(this.#directory),
    ];
    const available = await Promise.all(
      models.map((model) => model.available()),
    );
    return models.filter((_, index) => available[index]);
  }
}
