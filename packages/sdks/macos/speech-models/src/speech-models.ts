import { execFile } from 'node:child_process';
import { glob } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { SpeechModel } from './speech-model.ts';

const execute = promisify(execFile);

// Hugging Face's cache holds what hf, Handy and other tools download.
// Spotlight finds models anywhere else in the home folder, such as an app's
// Application Support folder, but it does not index ~/.cache.
export interface SpeechModelFolders {
  readonly hub: string;
  readonly home: string;
}

// Lists the speech models installed on this Mac, whichever app or tool put
// them there. It reads them in place and never modifies or downloads one.
export class SpeechModels {
  readonly #folders: SpeechModelFolders;

  constructor(
    folders: SpeechModelFolders = {
      hub: join(homedir(), '.cache/huggingface/hub'),
      home: homedir(),
    },
  ) {
    this.#folders = folders;
  }

  // One model per file name, the copy in Hugging Face's cache first.
  async list(): Promise<SpeechModel[]> {
    const paths = [...(await this.#cached()), ...(await this.#indexed())];
    const models = new Map<string, SpeechModel>();
    for (const model of await Promise.all(paths.map(read)))
      if (model !== undefined && !models.has(model.id))
        models.set(model.id, model);
    return [...models.values()].sort((left, right) =>
      left.title.localeCompare(right.title),
    );
  }

  async find(id: string): Promise<SpeechModel | undefined> {
    return (await this.list()).find((model) => model.id === id);
  }

  // Sorted, so the same copy wins each time a file is in several snapshots.
  async #cached(): Promise<string[]> {
    const paths = await Array.fromAsync(
      glob('models--*/snapshots/*/**/*.{gguf,bin}', {
        cwd: this.#folders.hub,
      }),
    );
    return paths.sort().map((path) => join(this.#folders.hub, path));
  }

  async #indexed(): Promise<string[]> {
    const { stdout } = await execute('/usr/bin/mdfind', [
      '-onlyin',
      this.#folders.home,
      'kMDItemFSName == "*.gguf"c || kMDItemFSName == "*.bin"c',
    ]);
    return stdout.split('\n').filter(Boolean);
  }
}

// Spotlight lists every .bin and .gguf file, and some cannot be read as a
// model, such as a download still in progress.
function read(path: string): Promise<SpeechModel | undefined> {
  return SpeechModel.read(path).catch(() => undefined);
}
