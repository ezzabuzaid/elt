import { lstat, mkdir, open, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  CopyConfiguration,
  Deduplication,
  FieldValues,
  ReloadMode,
  Stage,
  StoredFit,
} from '@workspace/elt';
import { TargetOwnedError, Writer, reloadMode } from '@workspace/elt';

import { MarkdownDocument } from './markdown-document.ts';

export abstract class MarkdownWriter extends Writer {
  readonly configuration: CopyConfiguration;
  readonly path: string;
  readonly document: MarkdownDocument;
  protected readonly deduplication?: Deduplication;
  constructor(
    configuration: CopyConfiguration,
    path: string,
    document: MarkdownDocument,
  ) {
    super(configuration.stream);
    this.configuration = configuration;
    this.path = path;
    this.document = document;
    const mode = configuration.destinationSyncMode;
    this.deduplication =
      mode === 'append_dedup' || mode === 'overwrite_dedup'
        ? configuration.deduplication()
        : undefined;
  }

  // The target's name, which also names its lock.
  protected abstract readonly name: string;

  // The owner and records the target named name holds now; none when it does
  // not exist.
  protected abstract read(name: string): Promise<{
    readonly owner?: string;
    readonly rows: readonly unknown[];
  }>;

  // Replaces the whole target named into with rows, owned by writer, in one
  // step.
  protected abstract publish(
    into: string,
    rows: readonly unknown[],
    writer: string,
  ): Promise<void>;

  // Puts the target at path from in place of the one at path to.
  protected abstract replace(from: string, to: string): Promise<void>;

  // A reload's hidden target, beside the target and invisible to readers.
  private get hiddenName(): string {
    return `.markdown-${this.name}.next`;
  }

  private removeHidden(): Promise<void> {
    return rm(join(this.path, this.hiddenName), {
      recursive: true,
      force: true,
    });
  }

  // The field's values in each of the targets named, which while a reload is
  // open are the target and its hidden target.
  private values(names: () => readonly string[]): FieldValues {
    const read = (name: string) => this.read(name);
    return async function* (field) {
      for (const name of names())
        for (const row of (await read(name)).rows)
          yield Reflect.get(Object(row), field);
    };
  }

  override async clear(
    writer: string,
    committed?: (values: FieldValues) => Promise<void>,
  ): Promise<void> {
    await using _ = await this.lock();
    const { owner } = await this.read(this.name);
    if (owner !== undefined && owner !== writer)
      throw new TargetOwnedError(this.name, owner, writer);
    await rm(join(this.path, this.name), { recursive: true, force: true });
    // Clearing a copy also abandons the reload it left open.
    await this.removeHidden();
    await committed?.(this.values(() => [this.name]));
  }

  // An exclusive directory prevents two cooperating writers from publishing the same target.
  private async lock(): Promise<AsyncDisposable> {
    await mkdir(this.path, { recursive: true });
    const lock = join(this.path, `.markdown-${this.name}.lock`);
    await mkdir(lock);
    return { [Symbol.asyncDispose]: () => rmdir(lock) };
  }

  // Each target is its own file or folder, so its in-memory rows are already
  // this stream's stage: a commit publishes only this target, or while a
  // reload is open its hidden target, which complete() puts in its place.
  async prepare({
    writer,
    restart,
    reloading,
  }: {
    writer: string;
    restart: boolean;
    reloading: boolean;
  }): Promise<Stage> {
    const lock = await this.lock();
    try {
      const target = await this.read(this.name);
      if (target.owner !== undefined && target.owner !== writer)
        throw new TargetOwnedError(this.name, target.owner, writer);
      const hidden = await this.read(this.hiddenName);
      // Markdown stores no shape, so a stored target always fits the stream.
      const fit = ({ owner }: { readonly owner?: string }): StoredFit =>
        owner === undefined ? 'missing' : 'fits';
      let mode: ReloadMode = reloadMode({
        reloading,
        restart,
        target: fit(target),
        hidden: fit(hidden),
      });
      // A hidden target no reload continues is a leftover readers never saw.
      if (mode !== 'continue') await this.removeHidden();
      const open = () => mode === 'reload' || mode === 'continue';
      const sync = this.configuration.destinationSyncMode;
      // ponytail: Markdown reconciliation holds the target in memory; use an on-disk index if exports outgrow memory.
      let published = new Map<string, unknown>();
      // A reload keeps none of the target's rows; one it continues keeps the
      // hidden target's.
      let kept: readonly unknown[] = [];
      if (mode === 'continue') kept = hidden.rows;
      else if (mode === 'load') kept = target.rows;
      if (sync === 'append' || sync === 'append_dedup')
        for (const row of kept) this.add(published, row);
      let working = new Map(published);
      return {
        fresh: mode === 'create' || mode === 'reload',
        get reloading() {
          return open();
        },
        values: this.values(() =>
          open() ? [this.name, this.hiddenName] : [this.name],
        ),
        apply: async (operation) => {
          if (operation.type === 'RECORD') {
            // Validate every observation, including deduplication losers.
            this.document.render(operation.data, 1);
            this.add(working, operation.data);
            return;
          }
          if (operation.type === 'RESET') {
            const { partition } = operation;
            if (partition === null) {
              // The whole stream starts over in a new hidden target.
              mode = 'reload';
              published = new Map();
              working = new Map();
              return;
            }
            for (const [key, row] of working)
              if (
                Object.entries(partition).every(
                  ([field, value]) => Reflect.get(Object(row), field) === value,
                )
              )
                working.delete(key);
            return;
          }
          if (this.deduplication === undefined)
            throw new TypeError('Only deduplicating loads can apply deletions');
          working.delete(this.deduplication.key(operation.key));
        },
        commit: async () => {
          await this.publish(
            open() ? this.hiddenName : this.name,
            [...working.values()],
            writer,
          );
          published = new Map(working);
        },
        complete: async () => {
          if (!open()) return;
          await this.replace(
            join(this.path, this.hiddenName),
            join(this.path, this.name),
          );
          mode = 'load';
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
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        throw error;
      return false;
    }
  }
}
