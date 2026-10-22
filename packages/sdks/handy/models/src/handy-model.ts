import { access } from 'node:fs/promises';
import { join } from 'node:path';

import type { LocalTranscriptionConfiguration } from '@workspace/transcription-local';

export abstract class HandyModel {
  abstract readonly id: string;
  abstract readonly title: string;
  abstract readonly engine: LocalTranscriptionConfiguration['engine'];
  protected abstract readonly files: readonly string[];
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  get configuration(): LocalTranscriptionConfiguration {
    return { engine: this.engine, directory: join(this.#root, this.id) };
  }

  async available(): Promise<boolean> {
    try {
      await Promise.all(
        this.files.map((file) =>
          access(join(this.configuration.directory, file)),
        ),
      );
      return true;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return false;
      throw error;
    }
  }
}
