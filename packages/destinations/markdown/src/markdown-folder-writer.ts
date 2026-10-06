import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  mkdtempDisposable,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import type { CopyConfiguration } from '@workspace/elt';

import { MarkdownDocument } from './markdown-document.ts';
import { MarkdownFolder } from './markdown-folder.ts';
import { MarkdownWriter } from './markdown-writer.ts';

export class MarkdownFolderWriter extends MarkdownWriter {
  readonly target: MarkdownFolder;

  constructor(
    configuration: CopyConfiguration,
    path: string,
    target: MarkdownFolder,
  ) {
    super(configuration, path, target.document);
    this.target = target;
    Object.freeze(this);
  }

  protected override get name(): string {
    return this.target.name;
  }

  protected override async read(name: string) {
    const path = join(this.path, name);
    if (!(await this.assertManagedFolder(path))) return { rows: [] };
    const rows: unknown[] = [];
    for (const name of (await readdir(path)).sort()) {
      if (name === MarkdownFolder.markerName) continue;
      rows.push(
        ...MarkdownDocument.records(await readFile(join(path, name), 'utf8')),
      );
    }
    return {
      owner: MarkdownFolder.writer(
        await readFile(join(path, MarkdownFolder.markerName), 'utf8'),
      ),
      rows,
    };
  }

  protected override async publish(
    into: string,
    rows: readonly unknown[],
    writer: string,
  ): Promise<void> {
    const { stream, target, deduplication } = this;
    await using staging = await mkdtempDisposable(
      join(this.path, '.markdown-'),
    );
    const next = join(staging.path, 'next');
    await mkdir(next, { mode: 0o700 });
    await writeFile(
      join(next, MarkdownFolder.markerName),
      MarkdownFolder.markerFor(writer),
      { flag: 'wx', mode: 0o600 },
    );
    for (const [index, record] of rows.entries()) {
      const document =
        target.document.header(stream) + target.document.render(record, 1);
      // Plain modes identify occurrences; deduplication identifies logical keys.
      const identity =
        deduplication !== undefined
          ? createHash('sha256').update(deduplication.key(record)).digest('hex')
          : index.toString(16).padStart(64, '0');
      await writeFile(join(next, `${identity}.md`), document, {
        flag: 'wx',
        mode: 0o600,
      });
    }
    await this.replace(next, join(this.path, into));
  }

  // Moves the folder at to into a backup before moving from in its place, and
  // restores the backup if that fails.
  protected override async replace(from: string, to: string): Promise<void> {
    const exists = await this.assertManagedFolder(to);
    const staging = await mkdtemp(join(this.path, '.markdown-'));
    const previous = join(staging, 'previous');
    let preserveBackup = false;
    try {
      // ponytail: two renames leave a brief path gap; use generation pointers if readers need an atomic folder switch.
      if (exists) await rename(to, previous);
      try {
        await rename(from, to);
      } catch (error) {
        if (exists) {
          try {
            await rename(previous, to);
          } catch (restoreError) {
            preserveBackup = true;
            throw new AggregateError(
              [error, restoreError],
              `Folder publication and restoration failed; previous export retained at ${previous}`,
              { cause: restoreError },
            );
          }
        }
        throw error;
      }
    } finally {
      // Never dispose the only remaining copy when restoration fails.
      if (!preserveBackup) await rm(staging, { recursive: true, force: true });
    }
  }

  private async assertManagedFolder(path: string): Promise<boolean> {
    let stats: Stats;
    try {
      stats = await lstat(path);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return false;
      throw error;
    }
    if (!stats.isDirectory())
      throw new TypeError(
        'Refusing to replace a non-directory Markdown folder',
      );
    const entries = await readdir(path, { withFileTypes: true });
    if (
      !entries.some(
        (entry) => entry.name === MarkdownFolder.markerName && entry.isFile(),
      )
    )
      throw new TypeError('Refusing to replace an unmanaged Markdown folder');
    MarkdownFolder.writer(
      await readFile(join(path, MarkdownFolder.markerName), 'utf8'),
    );
    for (const entry of entries) {
      if (entry.name === MarkdownFolder.markerName) continue;
      if (
        !entry.isFile() ||
        !/^[a-f0-9]{64}\.md$/.test(entry.name) ||
        !(await this.assertManagedFile(join(path, entry.name)))
      )
        throw new TypeError(
          'Refusing to replace a Markdown folder containing unmanaged entries',
        );
    }
    return true;
  }
}
