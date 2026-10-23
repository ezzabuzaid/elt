import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { catalog, modelFile } from '@handy-computer/models';

import type { LocalTranscriptionConfiguration } from '@workspace/transcription-local';

// Handy downloads a model through Hugging Face's cache, or into its own models
// folder when it falls back to its mirror.
export interface HandyFolders {
  readonly hub: string;
  readonly models: string;
}

export abstract class HandyModel {
  abstract readonly id: string;
  // The language transcribe.cpp is told the speech is in.
  protected abstract readonly language: string;
  readonly #folders: HandyFolders;

  constructor(folders: HandyFolders) {
    this.#folders = folders;
  }

  get title(): string {
    return this.#entry.name;
  }

  get installed(): boolean {
    return this.#paths.some(isFile);
  }

  // A model that is not installed points where Handy downloads it, so its load
  // error names that file.
  get configuration(): LocalTranscriptionConfiguration {
    const paths = this.#paths;
    return {
      name: this.id,
      path: paths.find(isFile) ?? paths[0],
      language: this.language,
    };
  }

  get #entry() {
    const entry = catalog.getModel(this.id);
    if (entry === undefined)
      throw new Error(`Handy's catalog has no model ${this.id}.`);
    return entry;
  }

  // The catalog's pinned revision comes first. Handy also loads the file from
  // a snapshot of another revision, as after the catalog moves its pin
  // (hf_snapshot_paths in Handy's src-tauri/src/managers/model.rs).
  get #paths(): [string, ...string[]] {
    const entry = this.#entry;
    const { filename } = modelFile(entry);
    const snapshots = join(
      this.#folders.hub,
      `models--${entry.repository.replaceAll('/', '--')}`,
      'snapshots',
    );
    const revisions = existsSync(snapshots) ? readdirSync(snapshots) : [];
    return [
      join(snapshots, entry.revision, filename),
      ...revisions
        .filter((revision) => revision !== entry.revision)
        .map((revision) => join(snapshots, revision, filename)),
      join(this.#folders.models, filename),
    ];
  }
}

function isFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
}
