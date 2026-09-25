import { lstat, open } from 'node:fs/promises';
import type { CopyConfiguration, Deduplication } from 'elt';
import { type WriteCount, type WriteOperation, Writer } from 'elt';
import { MarkdownDocument } from './markdown-document.ts';

export abstract class MarkdownWriter extends Writer {
  protected readonly deduplication?: Deduplication;
  constructor(
    readonly configuration: CopyConfiguration,
    readonly path: string,
    readonly document: MarkdownDocument,
  ) {
    super(configuration.stream);
    const mode = configuration.destinationSyncMode;
    this.deduplication =
      mode === 'append_dedup' || mode === 'overwrite_dedup'
        ? configuration.deduplication()
        : undefined;
  }

  protected async collect(
    operations: AsyncIterable<WriteOperation>,
    previous: unknown[],
  ): Promise<WriteCount & { rows: unknown[] }> {
    // ponytail: Markdown reconciliation holds the target in memory; use an on-disk index if exports outgrow memory.
    const { deduplication } = this;
    const replace = this.configuration.dedupPolicy === 'replace';
    const rows = new Map<string, unknown>();
    const add = (record: unknown) => {
      const key =
        deduplication === undefined
          ? String(rows.size)
          : deduplication.key(record);
      if (deduplication?.cursorField !== undefined)
        deduplication.cursor(record);
      const saved = rows.get(key);
      if (
        saved === undefined ||
        deduplication === undefined ||
        replace ||
        deduplication.newer(record, saved)
      )
        rows.set(key, structuredClone(record));
    };
    for (const record of previous) add(record);
    let count = 0;
    let deleted = 0;
    for await (const operation of operations) {
      if (operation.type === 'DELETE') {
        if (deduplication === undefined)
          throw new TypeError('Only deduplicating loads can apply deletions');
        rows.delete(deduplication.key(operation.key));
        deleted++;
        continue;
      }
      // Validate every observation, including deduplication losers, before acknowledging it.
      this.document.render(operation.data, 1);
      add(operation.data);
      count++;
    }
    return { rows: [...rows.values()], count, deleted };
  }

  protected async assertManagedFile(path: string): Promise<boolean> {
    try {
      if (!(await lstat(path)).isFile())
        throw new TypeError('Refusing to replace a non-file Markdown target');
      await using file = await open(path, 'r');
      const marker = Buffer.from(MarkdownDocument.marker);
      const buffer = Buffer.alloc(marker.length);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead !== marker.length || !buffer.equals(marker))
        throw new TypeError('Refusing to replace an unmanaged Markdown file');
      return true;
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      )
        throw error;
      return false;
    }
  }
}
