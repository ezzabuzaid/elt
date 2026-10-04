import { join } from 'node:path';
import { setInterval } from 'node:timers/promises';

import type {
  CopyConfiguration,
  ExtractionCoverage,
  SourceMessage,
  SourceWatchOptions,
  Stream,
} from '@workspace/elt';
import { Catalog, Source, diffSnapshot } from '@workspace/elt';
import type { ImportScope } from '@workspace/source-apple-macos/import-scope';
import { localAppleStoreCoverage } from '@workspace/source-apple-macos/local-apple-store-coverage';

import { AccountsStream } from './accounts-stream.ts';
import type { NotesReader } from './apple-notes-stream.ts';
import { AttachmentsStream } from './attachments-stream.ts';
import { FoldersStream } from './folders-stream.ts';
import { InlineAttachmentsStream } from './inline-attachments-stream.ts';
import { NoteStore, NoteStoreVersion, notesContainer } from './note-store.ts';
import { launchNotesHidden } from './notes-app.ts';
import { NotesScan, requiredColumns } from './notes-scan.ts';
import { NotesStream } from './notes-stream.ts';

const readers = {
  accounts: new AccountsStream(),
  folders: new FoldersStream(),
  notes: new NotesStream(),
  inlineAttachments: new InlineAttachmentsStream(),
  attachments: new AttachmentsStream(),
} satisfies Record<string, NotesReader>;
const catalog = new Catalog(
  Object.values(readers).map((reader) => reader.describe()),
);
const readersByName = new Map<string, NotesReader>(
  Object.values(readers).map((reader) => [reader.name, reader]),
);
// How often a watch checks the store for commits.
const pollIntervalMs = 1000;
// How often a watch makes sure Notes runs: macOS closes a hidden Notes when it
// frees disk space, and only Notes syncs iCloud notes.
const launchIntervalMs = 30_000;

// Reads Notes' own store, NoteStore.sqlite, so Notes.app need not run to
// export. Only Notes.app syncs iCloud notes, so a watch keeps it running,
// hidden.
export class AppleNotesSource extends Source<NotesScan> {
  readonly identity: string;
  protected readonly catalog = catalog;
  readonly accounts = readers.accounts.describe();
  readonly folders = readers.folders.describe();
  readonly notes = readers.notes.describe();
  readonly inlineAttachments = readers.inlineAttachments.describe();
  readonly attachments = readers.attachments.describe();

  readonly path: string;
  readonly scope: ImportScope;

  constructor({
    path = join(notesContainer, 'NoteStore.sqlite'),
    scope = {},
  }: {
    path?: string;
    scope?: ImportScope;
  } = {}) {
    super();
    this.path = path;
    this.scope = scope;
    this.identity = `apple-notes:${path}`;
    Object.freeze(this);
  }

  protected override async open(): Promise<NotesScan> {
    return new NotesScan(
      await NoteStore.open(this.path, requiredColumns),
      this.scope,
    );
  }

  override coverage(_stream: Stream): ExtractionCoverage {
    return { ...localAppleStoreCoverage, selection: this.scope };
  }

  protected override async *observe({
    streams,
    signal,
  }: SourceWatchOptions): AsyncGenerator<readonly Stream[]> {
    if (signal.aborted) return;
    using version = new NoteStoreVersion(this.path);
    let seen = version.current;
    await launchNotesHidden();
    let nextLaunch = Date.now() + launchIntervalMs;
    yield streams;
    try {
      for await (const _ of setInterval(pollIntervalMs, undefined, {
        signal,
      })) {
        if (Date.now() >= nextLaunch) {
          await launchNotesHidden();
          nextLaunch = Date.now() + launchIntervalMs;
        }
        const current = version.current;
        if (current === seen) continue;
        seen = current;
        yield streams;
      }
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError')) throw error;
    }
  }

  protected override async *extract(
    configuration: CopyConfiguration,
    state: unknown,
    _partition: null,
    scan: NotesScan,
  ): AsyncGenerator<SourceMessage> {
    const { stream } = configuration;
    const reader = readersByName.get(stream.name);
    if (reader === undefined)
      throw new Error(`Apple Notes has no stream ${stream.name}`);
    const records = await reader.read(scan);
    const messages =
      configuration.syncMode === 'incremental'
        ? diffSnapshot(stream, records, state)
        : records.map((data) => ({ stream: stream.name, data }));
    for await (const message of messages) {
      if ('type' in message || configuration.fileReads.length === 0)
        yield message;
      else
        yield {
          ...message,
          file: reader.file(message.data, scan),
        };
    }
  }
}
