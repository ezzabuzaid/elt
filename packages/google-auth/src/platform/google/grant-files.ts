import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import { atomicWrite, isErrno } from '@zukhruf/fs';

import type { GoogleOAuthCredential } from '../../credential.ts';
import type {
  GoogleActiveGrantPointer,
  GoogleGrantVaultStore,
} from '../../grant-store.ts';

/**
 * Grants as owner-only JSON files under one directory, the same posture gcloud
 * uses for its own refresh token. A write replaces the file in one step, so a
 * crash leaves the previous grant rather than a torn one.
 */
export class GrantFiles implements GoogleGrantVaultStore {
  readonly directory: string;

  constructor(directory: string) {
    if (!directory) throw new TypeError('Grant files need a directory');
    this.directory = resolve(directory);
    Object.freeze(this);
  }

  async read(ref: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(this.#path(ref), 'utf8'));
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return undefined;
      throw error;
    }
  }

  async write(
    ref: string,
    value: GoogleOAuthCredential | GoogleActiveGrantPointer,
  ): Promise<void> {
    const path = this.#path(ref);
    await mkdir(dirname(path), { mode: 0o700, recursive: true });
    await atomicWrite(path, JSON.stringify(value), { mode: 0o600 });
  }

  async remove(ref: string): Promise<void> {
    await rm(this.#path(ref), { force: true });
  }

  #path(ref: string): string {
    const path = resolve(this.directory, ref);
    const inside = relative(this.directory, path);
    if (!inside || inside.startsWith('..') || isAbsolute(inside))
      throw new TypeError(`Grant ref escapes the grant directory: ${ref}`);
    return path;
  }
}
