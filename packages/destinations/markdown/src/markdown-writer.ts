import { lstat, mkdir, open, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CopyConfiguration, Deduplication, Load } from 'elt';
import { TargetMissingError, TargetOwnedError, Writer } from 'elt';
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

  // The target's name, which also names its lock.
  protected abstract readonly name: string;

  // The owner and records the target holds now; none when it does not exist.
  protected abstract read(): Promise<{
    readonly owner?: string;
    readonly rows: readonly unknown[];
  }>;

  // Replaces the whole target with rows, owned by writer, in one step.
  protected abstract publish(
    rows: readonly unknown[],
    writer: string,
  ): Promise<void>;

  override async clear(writer: string): Promise<void> {
    await using _ = await this.lock();
    const { owner } = await this.read();
    if (owner !== undefined && owner !== writer)
      throw new TargetOwnedError(this.name, owner, writer);
    await rm(join(this.path, this.name), { recursive: true, force: true });
  }

  // An exclusive directory prevents two cooperating writers from publishing the same target.
  private async lock(): Promise<AsyncDisposable> {
    await mkdir(this.path, { recursive: true });
    const lock = join(this.path, `.markdown-${this.name}.lock`);
    await mkdir(lock);
    return { [Symbol.asyncDispose]: () => rmdir(lock) };
  }

  protected override async open(
    writer: string,
    resuming: boolean,
  ): Promise<Load> {
    const lock = await this.lock();
    try {
      const { owner, rows } = await this.read();
      if (resuming && owner === undefined)
        throw new TargetMissingError(this.name, writer);
      if (owner !== undefined && owner !== writer)
        throw new TargetOwnedError(this.name, owner, writer);
      const mode = this.configuration.destinationSyncMode;
      // ponytail: Markdown reconciliation holds the target in memory; use an on-disk index if exports outgrow memory.
      let published = new Map<string, unknown>();
      if (mode === 'append' || mode === 'append_dedup')
        for (const row of rows) this.add(published, row);
      let working = new Map(published);
      return {
        apply: async (operation) => {
          if (operation.type === 'RECORD') {
            // Validate every observation, including deduplication losers.
            this.document.render(operation.data, 1);
            this.add(working, operation.data);
            return;
          }
          if (this.deduplication === undefined)
            throw new TypeError('Only deduplicating loads can apply deletions');
          working.delete(this.deduplication.key(operation.key));
        },
        commit: async () => {
          await this.publish([...working.values()], writer);
          published = new Map(working);
        },
        discard: async () => {
          working = new Map(published);
        },
        [Symbol.asyncDispose]: () => lock[Symbol.asyncDispose](),
      };
    } catch (error) {
      await lock[Symbol.asyncDispose]();
      throw error;
    }
  }

  private add(rows: Map<string, unknown>, record: unknown): void {
    const { deduplication } = this;
    const key =
      deduplication === undefined
        ? String(rows.size)
        : deduplication.key(record);
    if (deduplication?.cursorField !== undefined) deduplication.cursor(record);
    const saved = rows.get(key);
    if (
      saved === undefined ||
      deduplication === undefined ||
      this.configuration.dedupPolicy === 'replace' ||
      deduplication.newer(record, saved)
    )
      rows.set(key, structuredClone(record));
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
