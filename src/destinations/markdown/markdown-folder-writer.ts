import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import type { CopyConfiguration } from '../../core/copy-configuration.ts';
import { CommittedWriteError } from '../../core/writer.ts';
import { MarkdownDocument } from './markdown-document.ts';
import { MarkdownFolder } from './markdown-folder.ts';
import { MarkdownWriter } from './markdown-writer.ts';

export class MarkdownFolderWriter extends MarkdownWriter {
  constructor(
    configuration: CopyConfiguration,
    path: string,
    readonly target: MarkdownFolder,
  ) {
    super(configuration, path, target.document);
    Object.freeze(this);
  }

  protected override async writeRecords(
    records: AsyncIterable<unknown>,
  ): Promise<number> {
    let committed: number | undefined;
    try {
      const { stream, target } = this;
      const path = join(this.path, target.name);
      await mkdir(this.path, { recursive: true });
      const lock = join(this.path, `.markdown-${target.name}.lock`);
      // An exclusive directory prevents two cooperating writers from swapping the same folder.
      await mkdir(lock);
      try {
        const existsBefore = await this.assertManagedFolder(path);
        const previousRows: unknown[] = [];
        if (
          existsBefore &&
          (this.configuration.destinationSyncMode === 'append' ||
            this.configuration.destinationSyncMode === 'append_dedup')
        ) {
          for (const name of (await readdir(path)).sort()) {
            if (name === MarkdownFolder.markerName) continue;
            previousRows.push(
              ...MarkdownDocument.records(
                await readFile(join(path, name), 'utf8'),
              ),
            );
          }
        }
        const { rows, count } = await this.collect(records, previousRows);
        const { deduplication } = this;
        const staging = await mkdtemp(join(this.path, '.markdown-'));
        const next = join(staging, 'next');
        const previous = join(staging, 'previous');
        let preserveBackup = false;
        try {
          await mkdir(next, { mode: 0o700 });
          await writeFile(
            join(next, MarkdownFolder.markerName),
            MarkdownFolder.marker,
            { flag: 'wx', mode: 0o600 },
          );
          for (const [index, record] of rows.entries()) {
            const document =
              target.document.header(stream) +
              target.document.render(record, 1);
            // Plain modes identify occurrences; deduplication identifies logical keys.
            const identity =
              deduplication !== undefined
                ? createHash('sha256')
                    .update(deduplication.key(record))
                    .digest('hex')
                : index.toString(16).padStart(64, '0');
            const filename = `${identity}.md`;
            await writeFile(join(next, filename), document, {
              flag: 'wx',
              mode: 0o600,
            });
          }
          const exists = await this.assertManagedFolder(path);
          // ponytail: two renames leave a brief path gap; use generation pointers if readers need an atomic folder switch.
          if (exists) await rename(path, previous);
          try {
            await rename(next, path);
          } catch (error) {
            if (exists) {
              try {
                await rename(previous, path);
              } catch (restoreError) {
                preserveBackup = true;
                throw new AggregateError(
                  [error, restoreError],
                  `Folder publication and restoration failed; previous export retained at ${previous}`,
                );
              }
            }
            throw error;
          }
          committed = count;
          return count;
        } finally {
          // Never dispose the only remaining copy when restoration fails.
          if (!preserveBackup)
            await rm(staging, { recursive: true, force: true });
        }
      } finally {
        await rmdir(lock);
      }
    } catch (cause) {
      if (committed !== undefined)
        throw new CommittedWriteError(
          committed,
          'Destination committed, but cleanup failed; retry may replay records',
          cause,
        );
      throw cause;
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
      ) ||
      (await readFile(join(path, MarkdownFolder.markerName), 'utf8')) !==
        MarkdownFolder.marker
    )
      throw new TypeError('Refusing to replace an unmanaged Markdown folder');
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
