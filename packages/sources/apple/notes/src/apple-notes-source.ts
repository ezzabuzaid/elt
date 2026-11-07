import { ClosedWorld } from '@zukhruf/snapshot-differential';

import type {
  CopyConfiguration,
  ExtractionCoverage,
  SourceMessage,
  Stream,
} from '@workspace/elt';
import { Catalog, Source, diffSnapshot } from '@workspace/elt';
import {
  NotesStore,
  StoreUnavailableError,
  launchNotesHidden,
  notesRunning,
} from '@workspace/sdk-apple-notes';
import type { ImportScope } from '@workspace/source-apple-macos/import-scope';
import { localAppleStoreCoverage } from '@workspace/source-apple-macos/local-apple-store-coverage';

import { AccountsStream } from './accounts-stream.ts';
import type { NotesReader } from './apple-notes-stream.ts';
import { AttachmentsStream } from './attachments-stream.ts';
import { FoldersStream } from './folders-stream.ts';
import { InlineAttachmentsStream } from './inline-attachments-stream.ts';
import { NotesScan } from './notes-scan.ts';
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
  readonly identity = 'apple-notes';
  protected readonly catalog = catalog;
  readonly accounts = catalog.get(readers.accounts.name);
  readonly folders = catalog.get(readers.folders.name);
  readonly notes = catalog.get(readers.notes.name);
  readonly inlineAttachments = catalog.get(readers.inlineAttachments.name);
  readonly attachments = catalog.get(readers.attachments.name);

  readonly path: string;
  readonly scope: ImportScope;
  readonly #store: NotesStore;

  constructor({ path, scope = {} }: { path: string; scope?: ImportScope }) {
    super();
    this.path = path;
    this.scope = scope;
    this.#store = new NotesStore(path);
    Object.freeze(this);
  }

  protected override async open(): Promise<NotesScan> {
    return new NotesScan(this.#store.open(), this.scope);
  }

  protected override readonly configErrors = [StoreUnavailableError];

  override coverage(_stream: Stream): ExtractionCoverage {
    return { ...localAppleStoreCoverage, selection: this.scope };
  }

  // Only Notes.app syncs iCloud notes, so while it is closed the store stays
  // as of when Notes last wrote it.
  override async currentAsOf(): Promise<Date | null> {
    return (await notesRunning()) ? null : this.#store.lastWrite();
  }

  override changeSignals(streams: readonly Stream[]) {
    return [
      {
        gauge: this.#store.version(),
        streams,
        interval: pollIntervalMs,
        // A data_version read is local: a check that takes the whole
        // interval is stuck.
        timeout: pollIntervalMs,
      },
    ];
  }

  // Launching Notes is work between checks, not a read of the store.
  override upkeep() {
    return [
      {
        interval: launchIntervalMs,
        run: async (signal: AbortSignal) => {
          await launchNotesHidden(signal);
        },
      },
    ];
  }

  protected override async *extract(
    configuration: CopyConfiguration,
    state: unknown,
    _partition: null,
    scan: NotesScan,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<SourceMessage> {
    const { stream } = configuration;
    const reader = readersByName.get(stream.name);
    if (reader === undefined)
      throw new Error(`Apple Notes has no stream ${stream.name}`);
    const records = reader.read(scan);
    const messages = diffSnapshot(configuration, records, state, {
      policy: new ClosedWorld(),
      signal,
    });
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
