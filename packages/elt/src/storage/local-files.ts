import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type { FileContent } from '../core/file-content.ts';
import { fileExtension } from '../core/file-extension.ts';
import { FileStorage } from '../core/file-storage.ts';

async function syncDirectory(path: string): Promise<void> {
  await using directory = await open(path, 'r');
  await directory.sync();
}

export class LocalFiles extends FileStorage {
  readonly directory: string;
  readonly identity: string;
  readonly reference =
    'Path of a copy of the source file bytes, relative to the folder the load stores files in. Named by content hash, keeping a short source extension, and kept only while a row references it. Not the source file name, a URL or extracted text.';

  constructor({ directory }: { directory: string }) {
    super();
    if (
      typeof directory !== 'string' ||
      directory.length === 0 ||
      directory.includes('\0') ||
      !directory.isWellFormed()
    )
      throw new TypeError('LocalFiles requires a directory');
    this.directory = resolve(directory);
    // References are relative to the folder, so the folder is no part of the
    // identity: a store moved with its files keeps every reference.
    this.identity = JSON.stringify({ type: 'local-files' });
    Object.freeze(this);
  }

  // The scope's folder, relative to the storage folder.
  private scopeFolder(scope: string): string {
    return join('.elt-files', createHash('sha256').update(scope).digest('hex'));
  }

  private async inspect(path: string): Promise<boolean> {
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (info === undefined) return false;
    if (!info.isDirectory())
      throw new TypeError(
        `Managed attachment directories must be real directories: ${path}`,
      );
    return true;
  }

  override async save(scope: string, content: FileContent): Promise<string> {
    const folder = this.scopeFolder(scope);
    const directory = join(this.directory, folder);
    // Sync newly created directory entries as well as the file publication.
    const created = await mkdir(directory, { recursive: true });
    for (const path of [this.directory, dirname(directory), directory])
      await this.inspect(path);
    if (created !== undefined) {
      let path = directory;
      while (path !== dirname(created)) {
        await syncDirectory(path);
        path = dirname(path);
      }
      await syncDirectory(path);
    }
    const temporary = join(directory, `.pending-${randomUUID()}`);
    try {
      const hash = createHash('sha256');
      {
        await using file = await open(temporary, 'wx', 0o600);
        for await (const chunk of content.chunks(4 * 1024 * 1024)) {
          hash.update(chunk);
          await file.writeFile(chunk);
        }
        await file.sync();
      }
      const name = hash.digest('hex') + fileExtension(content.path);
      const path = join(directory, name);
      await link(temporary, path).catch(
        async (error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
          if (!(await lstat(path)).isFile())
            throw new TypeError(
              `Attachment reference is not a regular file: ${path}`,
            );
        },
      );
      await syncDirectory(directory);
      return join(folder, name);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  override async retain(
    scope: string,
    references: ReadonlySet<string>,
  ): Promise<void> {
    const folder = this.scopeFolder(scope);
    const directory = join(this.directory, folder);
    for (const path of [this.directory, dirname(directory), directory]) {
      if (await this.inspect(path)) continue;
      if (references.size > 0)
        throw new Error(`Stored attachment directory is missing: ${directory}`);
      return;
    }
    // ponytail: scan this field's managed directory at commit; use an object
    // index if attachment counts make reconciliation expensive.
    const missing = new Set(references);
    const obsolete: string[] = [];
    // Only this scope's saves write here, so every file no row references is
    // obsolete, a crashed save's .pending- file included.
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (!entry.isFile())
        throw new TypeError(
          `Managed attachment is not a regular file: ${path}`,
        );
      const reference = join(folder, entry.name);
      if (references.has(reference)) missing.delete(reference);
      else obsolete.push(path);
    }
    if (missing.size > 0)
      throw new Error(
        `Stored attachment is missing or outside its scope: ${[...missing][0]}`,
      );
    for (const path of obsolete) await rm(path);
    await syncDirectory(directory);
  }
}
