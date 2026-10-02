import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
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
import type { GoogleRequester } from 'google-auth';
import type { ImportScope, Selection } from 'import-store';
import type { Choice, Row, Rows } from './choice.ts';

// What the host running an app offers it.
export type AppleHost = {
  // The app macOS grants access to: ChatGPT for the plugin, the terminal
  // that launched the CLI.
  readonly grantee: string;
  // A Google session for content an Apple app keeps in Google, such as
  // Calendar attachments in Drive and Gmail. Without one, it stays a link.
  google?(scopes: readonly string[]): Promise<GoogleRequester>;
};

export type ChoiceOptions = Choice & {
  readonly options: readonly { readonly id: string; readonly label: string }[];
};

// One Apple app a host imports. Each app declares its facts and its source;
// this class lists what it can be narrowed by, builds its load and words its
// selection and failures the same way for every app and host.
export abstract class AppleApp {
  abstract readonly name: string;
  abstract readonly title: string;
  // What a date range selects, or null when this app's records have no date.
  abstract readonly datedBy: string | null;
  // Whether macOS keeps the app's store behind Full Disk Access, which it
  // never asks for.
  abstract readonly fullDiskAccess: boolean;
  // What to know before narrowing this app, such as how its collections nest.
  readonly note?: string;
  // The streams listing the accounts or collections an import can be
  // narrowed to.
  protected abstract readonly choices: readonly Choice[];
  // For an app with no choices: a stream read only to show its store opens.
  protected readonly probe?: string;
  // Streams whose rows belong to no account or collection: a narrowed import
  // cannot attribute them, so it leaves them out.
  protected abstract readonly unscoped: readonly string[];
  // File streams that copy the app's own store rather than attachments; they
  // load metadata only.
  protected abstract readonly storeCopies: readonly string[];

  constructor(protected readonly host: AppleHost) {}

  // What macOS needs granted to the grantee, besides Full Disk Access.
  protected abstract access(grantee: string): string;

  protected abstract source(scope: ImportScope): Source;

  // The source an import loads from; listing choices reads source(scope).
  protected importSource(scope: ImportScope): Source | Promise<Source> {
    return this.source(scope);
  }

  // The scope an import uses for what its selection leaves out.
  defaultScope(): ImportScope {
    return {};
  }

  narrowsBy(kind: Choice['scope']): boolean {
    return this.choices.some(({ scope }) => scope === kind);
  }

  guidance(): string {
    const { grantee } = this.host;
    return [
      ...(this.fullDiskAccess
        ? [
            `Turn on ${grantee} in System Settings › Privacy & Security › Full Disk Access, then quit and reopen ${grantee}. macOS does not ask for this access.`,
          ]
        : []),
      this.access(grantee),
    ].join(' ');
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

  // The rows of the streams this app can be narrowed by. Opening the app's
  // store is also what makes macOS ask for access, so a denied app fails
  // here, before anything is selected.
  async choiceRows(): Promise<Rows> {
    const source = this.source(this.defaultScope());
    const catalog = await source.discover();
    const streams =
      this.probe === undefined
        ? this.choices.map(({ stream }) => stream)
        : [this.probe];
    const rows = new Map<string, Row[]>();
    for await (const message of source.read(
      streams.map(
        (stream) =>
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
      // Every Apple source validates its records against the stream's object
      // schema.
      if (!('type' in message) && message.stream !== this.probe)
        rows.set(message.stream, [
          ...(rows.get(message.stream) ?? []),
          message.data as Row,
        ]);
    }
    return rows;
  }

  async listChoices(): Promise<ChoiceOptions[]> {
    const rows = await this.choiceRows();
    return this.choices.map((choice) => ({
      ...choice,
      options: (rows.get(choice.stream) ?? []).map((row) => ({
        id: choice.id(row),
        label: choice.label(row, rows),
      })),
    }));
  }

  // The app's streams, loaded incrementally into raw_<stream> tables of the
  // import directory's data.sqlite and read through documented views, with
  // checkpoints.sqlite and attachment copies in files/ beside it.
  async connection(
    directory: string,
    selection: Selection,
  ): Promise<{
    connection: Connection<SQLiteTable>;
    destination: SQLiteDestination;
  }> {
    const { scope, includeAttachments } = selection;
    const source = await this.importSource(scope);
    const narrowed = Object.keys(scope).length > 0;
    const { streams } = await source.discover();
    const withFiles = (stream: Stream) =>
      includeAttachments &&
      stream.supportsFileTransfer === true &&
      !this.storeCopies.includes(stream.name);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const destination = new SQLiteDestination({
      path: join(directory, 'data.sqlite'),
    });
    const files = new LocalFiles({ directory: join(directory, 'files') });
    const connection = new Connection({
      name: this.name,
      source,
      destination,
      checkpoints: new SQLiteCheckpointStore({
        path: join(directory, 'checkpoints.sqlite'),
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
}
