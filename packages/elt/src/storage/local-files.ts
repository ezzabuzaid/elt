import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readdir, rm } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import type { FileContent } from '../core/file-content.ts';
import { FileStorage } from '../core/file-storage.ts';

async function syncDirectory(path: string): Promise<void> {
  await using directory = await open(path, 'r');
  await directory.sync();
}

export class LocalFiles extends FileStorage {
  readonly directory: string;
  readonly identity: string;
  readonly reference =
    'Absolute path, on the machine that ran the load, of a copy of the source file bytes. Named by content hash, keeping a short source extension, and kept only while a row references it. Not the source file name, a URL or extracted text.';

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
    this.identity = JSON.stringify({
      type: 'local-files',
      directory: this.directory,
    });
    Object.freeze(this);
  }

  private scopePath(scope: string): string {
    return join(
      this.directory,
      '.elt-files',
      createHash('sha256').update(scope).digest('hex'),
    );
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
    const directory = this.scopePath(scope);
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
      const extension = extname(content.path);
      const path = join(
        directory,
        hash.digest('hex') +
          (/^\.[a-zA-Z0-9]{1,16}$/.test(extension) ? extension : ''),
      );
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
      return path;
    } finally {
      await rm(temporary, { force: true });
    }
  }

  override async retain(
    scope: string,
    references: ReadonlySet<string>,
  ): Promise<void> {
    const directory = this.scopePath(scope);
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
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (references.has(path)) {
        if (!entry.isFile())
          throw new TypeError(
            `Attachment reference is not a regular file: ${path}`,
          );
        missing.delete(path);
        continue;
      }
      if (
        /^(?:[a-f0-9]{64}(?:\.[a-zA-Z0-9]{1,16})?|\.pending-[a-f0-9-]+)$/.test(
          entry.name,
        )
      ) {
        if (!entry.isFile())
          throw new TypeError(
            `Managed attachment is not a regular file: ${path}`,
          );
        obsolete.push(path);
      }
    }
    if (missing.size > 0)
      throw new Error(
        `Stored attachment is missing or outside its scope: ${[...missing][0]}`,
      );
    for (const path of obsolete) await rm(path);
    await syncDirectory(directory);
  }
}
