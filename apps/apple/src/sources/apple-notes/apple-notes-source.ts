import { on } from 'node:events';
import fs from 'node:fs';
import { lstat, mkdtempDisposable } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import type { CopyConfiguration, SourceWatchOptions, Stream } from 'elt';
import { Catalog, isTimestamp, Source, type SourceMessage } from 'elt';
import { AccountsStream } from './accounts-stream.ts';
import { AttachmentsStream } from './attachments-stream.ts';
import { FoldersStream } from './folders-stream.ts';
import { NotesStream } from './notes-stream.ts';

const readers = Object.freeze({
  accounts: new AccountsStream(),
  folders: new FoldersStream(),
  notes: new NotesStream(),
  attachments: new AttachmentsStream(),
});
const catalog = new Catalog(
  Object.values(readers).map((reader) => reader.describe()),
);

export class AppleNotesSource extends Source {
  readonly identity = 'apple-notes:local';
  protected readonly catalog = catalog;
  readonly accounts = catalog.get('accounts');
  readonly folders = catalog.get('folders');
  readonly notes = catalog.get('notes');
  readonly attachments = catalog.get('attachments');

  constructor() {
    super();
    Object.freeze(this);
  }

  protected override async *observe({
    streams,
    signal,
  }: SourceWatchOptions): AsyncGenerator<readonly Stream[]> {
    if (signal.aborted) return;
    // Native filesystem invalidations, not a public Notes change feed. Re-read through JXA.
    const path = join(
      homedir(),
      'Library/Group Containers/group.com.apple.notes',
    );
    try {
      const watcher = fs.watch(path, { recursive: true, signal });
      try {
        await using changes = on(watcher, 'change', { signal });
        yield streams;
        for await (const _ of changes) yield streams;
      } finally {
        watcher.close();
      }
    } catch (cause) {
      if (
        cause instanceof Error &&
        'code' in cause &&
        (cause.code === 'EPERM' || cause.code === 'EACCES')
      )
        throw new Error(
          `Apple Notes watching cannot access ${path}. Allow the host process Full Disk Access in System Settings > Privacy & Security and run outside a sandbox that blocks this directory.`,
          { cause },
        );
      throw cause;
    }
  }

  protected override validateExtraction(
    configuration: CopyConfiguration,
  ): void {
    if (
      configuration.syncMode === 'incremental' &&
      configuration.cursorField !== 'modifiedAt'
    )
      throw new TypeError(
        'Apple Notes incremental extraction requires the modifiedAt cursor',
      );
  }

  protected override async *extract(
    configuration: CopyConfiguration,
    state: unknown,
  ): AsyncGenerator<SourceMessage> {
    const reader = readers[configuration.stream.name as keyof typeof readers];
    if (configuration.syncMode === 'full_refresh') {
      for await (const data of reader.read())
        yield* this.record(data, configuration);
      return;
    }
    const saved: unknown =
      state === null
        ? null
        : typeof state === 'object' &&
            !Array.isArray(state) &&
            Object.keys(state).length === 1 &&
            Object.hasOwn(state, 'modifiedAt')
          ? Reflect.get(state, 'modifiedAt')
          : undefined;
    if (saved !== null && !isTimestamp(saved))
      throw new TypeError('Invalid Apple Notes checkpoint');
    let watermark = saved;
    const startedAt = new Date().toISOString();
    // ponytail: JXA scans all records; incremental filtering reduces emitted data, not source scan cost.
    for await (const data of reader.read()) {
      const modifiedAt: unknown = Reflect.get(data, 'modifiedAt');
      if (!isTimestamp(modifiedAt))
        throw new TypeError('Notes returned an invalid modifiedAt cursor');
      if (saved !== null && modifiedAt < saved) continue;
      yield* this.record(data, configuration);
      // Re-read equal timestamps, and changes made during this non-atomic scan.
      const observed = modifiedAt < startedAt ? modifiedAt : startedAt;
      if (watermark === null || observed > watermark) watermark = observed;
    }
    yield {
      type: 'STATE',
      stream: reader.name,
      state: { modifiedAt: watermark },
    };
  }

  private async *record(
    data: { id: string; name: string | null },
    configuration: CopyConfiguration,
  ): AsyncGenerator<SourceMessage> {
    const stream = configuration.stream.name;
    if (configuration.fileReads.length === 0) {
      yield { stream, data };
      return;
    }
    await using scratch = await mkdtempDisposable(
      join(tmpdir(), 'mac-elt-attachment-'),
    );
    // Notes may supply no filename. Keep that fact in metadata; never use a source path.
    const extension = data.name === null ? '' : extname(data.name);
    const path = join(scratch.path, `content${extension}`);
    const exported = await readers.attachments.save(data.id, path);
    if (exported && !(await lstat(path)).isFile())
      throw new TypeError('Notes did not export a regular attachment file');
    yield { stream, data, file: exported ? path : null };
  }
}
