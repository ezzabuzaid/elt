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

  get #models(): HandyModel[] {
    return [new CohereModel(this.#directory), new CanaryModel(this.#directory)];
  }

  async list(): Promise<HandyModel[]> {
    const models = this.#models;
    const available = await Promise.all(
      models.map((model) => model.available()),
    );
    return models.filter((_, index) => available[index]);
  }

  // The model Handy keeps under this id, whether or not its files are there.
  find(id: string): HandyModel | undefined {
    return this.#models.find((model) => model.id === id);
  }
}
