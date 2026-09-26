import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import type { GoogleOAuthCredential } from '../../credential.ts';
import type {
  GoogleActiveGrantPointer,
  GoogleGrantVaultStore,
} from '../../grant-store.ts';

/**
 * Grants as owner-only JSON files under one directory, the same posture gcloud
 * uses for its own refresh token. A write lands through a temporary file and a
 * rename, so a crash leaves the previous grant rather than a torn one.
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
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  async write(
    ref: string,
    value: GoogleOAuthCredential | GoogleActiveGrantPointer,
  ): Promise<void> {
    const path = this.#path(ref);
    await mkdir(dirname(path), { mode: 0o700, recursive: true });
    const staging = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(staging, JSON.stringify(value), {
        flag: 'wx',
        mode: 0o600,
      });
      await rename(staging, path);
    } finally {
      await rm(staging, { force: true });
    }
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

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    Reflect.get(error, 'code') === 'ENOENT'
  );
}
