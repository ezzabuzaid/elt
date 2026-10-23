import { homedir } from 'node:os';
import { join } from 'node:path';

import { CohereArabicModel } from './cohere-arabic-model.ts';
import type { HandyFolders, HandyModel } from './handy-model.ts';

// Handy owns these downloads; readers reuse them in place and never modify
// them. Handy opened from the Dock has no HF_HOME, so Hugging Face's cache is
// in its default place.
export class HandyModels {
  readonly #folders: HandyFolders;

  constructor(
    folders: HandyFolders = {
      hub: join(homedir(), '.cache/huggingface/hub'),
      models: join(
        homedir(),
        'Library/Application Support/com.pais.handy/models',
      ),
    },
  ) {
    this.#folders = folders;
  }

  get #models(): HandyModel[] {
    return [new CohereArabicModel(this.#folders)];
  }

  list(): HandyModel[] {
    return this.#models.filter((model) => model.installed);
  }

  // The model Handy keeps under this id, whether or not its file is there.
  find(id: string): HandyModel | undefined {
    return this.#models.find((model) => model.id === id);
  }
}
