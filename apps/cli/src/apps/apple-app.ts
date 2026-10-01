import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { ImportScope } from 'apple/sources/import-scope';
import {
  Connection,
  Copy,
  CopyConfiguration,
  LocalFiles,
  type Source,
  type Stream,
  StreamStatus,
} from 'elt';
import {
  SQLiteCheckpointStore,
  SQLiteColumns,
  SQLiteDestination,
  type SQLiteTable,
} from 'elt-sqlite';
import type { Selection, Store } from '../store.ts';
import type { Choice, Row } from './choice.ts';

export type ChoiceOptions = Choice & {
  readonly options: readonly { readonly id: string; readonly label: string }[];
};

// One Apple app the CLI imports. Each app declares its facts and its source;
// this class lists what it can be narrowed by, builds its load and words its
// selection and failures the same way for every app.
export abstract class AppleApp {
  abstract readonly name: string;
  abstract readonly title: string;
  // What a date range selects, or null when this app's records have no date.
  abstract readonly datedBy: string | null;
  // The streams listing the accounts or collections an import can be
  // narrowed to.
  protected abstract readonly choices: readonly Choice[];
  // Streams whose rows belong to no account or collection: a narrowed import
  // cannot attribute them, so it leaves them out.
  protected abstract readonly unscoped: readonly string[];
  // File streams that copy the app's own store rather than attachments; they
  // load metadata only.
  protected abstract readonly storeCopies: readonly string[];

  // What macOS needs granted to the terminal app before this app can be read.
  protected abstract access(terminal: string): string;

  protected abstract source(scope: ImportScope): Source;

  narrowsBy(kind: Choice['scope']): boolean {
    return this.choices.some(({ scope }) => scope === kind);
  }

  guidance(): string {
    return this.access(terminalApp());
  }

  // What failed, and what macOS access the app needs, for the user to act on.
  failure(error: unknown): string {
    return `${error instanceof Error ? error.message : String(error)} — ${this.guidance()}`;
  }

  // What a selection of this app covers, in a person's words.
  describe(scope: ImportScope): string {
    const parts = [
      ...this.choices.flatMap(({ scope: ids, title }) =>
        scope[ids] ? [`${scope[ids].length} ${title}`] : [],
      ),
      ...(scope.startAt ? [`from ${scope.startAt.slice(0, 10)}`] : []),
      ...(scope.endAt ? [`until ${scope.endAt.slice(0, 10)}`] : []),
    ];
    return parts.length === 0 ? 'everything' : parts.join(', ');
  }

  // The app and what a selection of it covers, as one phrase.
  titled(scope: ImportScope): string {
    const covers = this.describe(scope);
    return covers === 'everything' ? this.title : `${this.title} (${covers})`;
  }

  // The reader view of a stream: raw_inlineAttachments reads as
  // inline_attachments.
  view(stream: string): string {
    return stream.replaceAll(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  }

  // Reads the streams this app can be narrowed by. Opening the app's store is
  // also what makes macOS ask for access, so a denied app fails here, before
  // anything is selected.
  async listChoices(): Promise<ChoiceOptions[]> {
    const source = this.source({});
    const catalog = await source.discover();
    const rows = new Map<string, Row[]>();
    for await (const message of source.read(
      this.choices.map(
        ({ stream }) =>
          new CopyConfiguration(catalog.get(stream), {
            syncMode: 'full_refresh',
            destinationSyncMode: 'overwrite',
          }),
      ),
      new Map(),
    )) {
      if (message instanceof StreamStatus) {
        if (message.status === 'FAILED') throw message.error;
        continue;
      }
      if (!('type' in message)) {
        const streamRows = rows.get(message.stream) ?? [];
        streamRows.push(message.data as Row);
        rows.set(message.stream, streamRows);
      }
    }
    return this.choices.map((choice) => ({
      ...choice,
      options: (rows.get(choice.stream) ?? []).map((row) => ({
        id: choice.id(row),
        label: choice.label(row, rows),
      })),
    }));
  }

  // The app's streams, loaded incrementally into raw_<stream> tables of its
  // data.sqlite and read through documented views, with files kept beside it.
  async connection(
    store: Store,
    { scope, attachments }: Selection,
  ): Promise<{
    connection: Connection<SQLiteTable>;
    destination: SQLiteDestination;
  }> {
    const source = this.source(scope);
    const narrowed = Object.keys(scope).length > 0;
    const { streams } = await source.discover();
    const withFiles = (stream: Stream) =>
      attachments &&
      stream.supportsFileTransfer === true &&
      !this.storeCopies.includes(stream.name);
    mkdirSync(store.directory(this.name), { recursive: true });
    const destination = new SQLiteDestination({
      path: store.database(this.name),
    });
    const files = new LocalFiles({
      directory: join(store.directory(this.name), 'files'),
    });
    const connection = new Connection({
      name: this.name,
      source,
      destination,
      checkpoints: new SQLiteCheckpointStore({
        path: join(store.directory(this.name), 'checkpoints.sqlite'),
      }),
      steps: streams
        .filter(({ name }) => !(narrowed && this.unscoped.includes(name)))
        .map(
          (stream) =>
            new Copy(
              stream,
              destination
                .table(
                  `raw_${stream.name}`,
                  withFiles(stream)
                    ? (columns) => [
                        ...SQLiteColumns.fromSchema(stream.jsonSchema),
                        columns
                          .text('attachmentRef')
                          .from(stream.file.store(files)),
                      ]
                    : undefined,
                )
                .withReaderView(this.view(stream.name)),
              {
                id: `${this.name}:${stream.name}`,
                syncMode: 'incremental',
                destinationSyncMode: 'append_dedup',
              },
            ),
        ),
    });
    return { connection, destination };
  }

  protected fullDiskAccess(terminal: string): string {
    return `Turn on ${terminal} in System Settings › Privacy & Security › Full Disk Access, then quit and reopen ${terminal}. macOS does not ask for this access.`;
  }
}

// The app macOS asks for access on behalf of: the one that launched this
// process. TERM_PROGRAM cannot name it; cmux, for one, reports ghostty.
function terminalApp(): string {
  const bundle = process.env.__CFBundleIdentifier;
  if (bundle !== undefined && /^[\w.-]+$/.test(bundle))
    try {
      const [path] = execFileSync(
        '/usr/bin/mdfind',
        [`kMDItemCFBundleIdentifier == '${bundle}'`],
        { encoding: 'utf8', timeout: 5_000 },
      ).split('\n');
      if (path) return basename(path, extname(path));
    } catch {
      // Spotlight is unavailable: name the app generically.
    }
  return 'your terminal app';
}
