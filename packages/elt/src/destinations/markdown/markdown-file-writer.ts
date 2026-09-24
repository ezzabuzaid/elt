import {
  mkdir,
  mkdtempDisposable,
  open,
  readFile,
  rename,
  rmdir,
} from 'node:fs/promises';
import { join } from 'node:path';
import type { CopyConfiguration } from '../../core/copy-configuration.ts';
import {
  CommittedWriteError,
  type WriteCount,
  type WriteOperation,
} from '../../core/writer.ts';
import { MarkdownDocument } from './markdown-document.ts';
import type { MarkdownFile } from './markdown-file.ts';
import { MarkdownWriter } from './markdown-writer.ts';

export class MarkdownFileWriter extends MarkdownWriter {
  constructor(
    configuration: CopyConfiguration,
    path: string,
    readonly target: MarkdownFile,
  ) {
    super(configuration, path, target.document);
    Object.freeze(this);
  }

  protected override async writeRecords(
    operations: AsyncIterable<WriteOperation>,
  ): Promise<WriteCount> {
    let committed: WriteCount | undefined;
    try {
      const { stream, target } = this;
      const path = join(this.path, target.name);
      await mkdir(this.path, { recursive: true });
      const lock = join(this.path, `.markdown-${target.name}.lock`);
      await mkdir(lock);
      try {
        const exists = await this.assertManagedFile(path);
        const previous =
          exists &&
          (this.configuration.destinationSyncMode === 'append' ||
            this.configuration.destinationSyncMode === 'append_dedup')
            ? MarkdownDocument.records(await readFile(path, 'utf8'))
            : [];
        const { rows, count, deleted } = await this.collect(
          operations,
          previous,
        );
        await using staging = await mkdtempDisposable(
          join(this.path, '.markdown-'),
        );
        const stagedPath = join(staging.path, target.name);
        {
          await using file = await open(stagedPath, 'wx', 0o600);
          await file.writeFile(target.document.header(stream));
          for (const [index, record] of rows.entries())
            await file.writeFile(target.document.render(record, index + 1));
        }
        await this.assertManagedFile(path);
        await rename(stagedPath, path);
        committed = { count, deleted };
        return committed;
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
}
