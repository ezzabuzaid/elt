import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  Connection,
  Copy,
  CopyConfiguration,
  type FailureType,
  LocalFiles,
  Pipeline,
  PipelineError,
  type Source,
  type Stream,
  StreamStatus,
} from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteColumns,
  SQLiteDestination,
  type SQLiteSyncHistory,
  type SQLiteTable,
  installSQLiteCatalog,
} from '@workspace/elt-sqlite';
import type { GoogleRequester } from '@workspace/google-auth';
import {
  ConnectorRemovedError,
  type Selection,
  type Settings,
} from '@workspace/settings';
import type { ImportScope } from '@workspace/source-apple-macos/import-scope';

import type { Choice, Row, Rows } from './choice.ts';

// What the host running a connector offers it.
export type AppleHost = {
  // The app macOS grants access to: ChatGPT for the plugin, the terminal
  // that launched the CLI.
  readonly grantee: string;
  // The compiled EventKit helper Calendar and Reminders read through: beside
  // the plugin's bundled server, or in @workspace/sdk-apple-eventkit's dist.
  readonly eventKitHelper: string;
  // A Google session for content an Apple app keeps in Google, such as
  // Calendar attachments in Drive and Gmail. Without one, it stays a link.
  google?(scopes: readonly string[]): Promise<GoogleRequester>;
};

// The connector's name and title, as its manifest declares them, and the
// folder the manifest was read from.
export type ConnectorIdentity = {
  readonly name: string;
  readonly title: string;
  readonly folder: string;
};

// A view a reader can load before querying an import: a SQL file that creates
// one temporary view named after the file, so nothing is stored in the import.
export type Preset = {
  readonly name: string;
  readonly file: string;
};

export type ChoiceOptions = Choice & {
  readonly options: readonly { readonly id: string; readonly label: string }[];
};

// How one pass of an import ended, for its host to show.
export type ImportOutcome =
  // The pass ran; the import's sync history records how each stream went.
  | { readonly status: 'imported' }
  // The user removed the connector while its pass ran; its import is now stale.
  | { readonly status: 'removed' }
  // No connection could be built; the settings keep why, for status.
  | { readonly status: 'unconnected'; readonly error: unknown };

// The connector for one Apple app. A subclass declares the app's facts and its
// source; this class lists what it can be narrowed by, builds its load and
// words its selection and failures the same way for every connector and host.
export abstract class AppleConnector {
  readonly name: string;
  readonly title: string;
  // Where the connector keeps its presets, beside its manifest; it may not
  // exist.
  readonly presetsFolder: string;
  // What a date range selects, or null when this app's records have no date.
  abstract readonly datedBy: string | null;
  // Whether macOS keeps the app's store behind Full Disk Access, which it
  // never asks for.
  abstract readonly fullDiskAccess: boolean;
  // What to know before narrowing this connector, such as how the app's
  // collections nest.
  readonly note?: string;
  // The streams listing the accounts or collections an import can be
  // narrowed to.
  protected abstract readonly choices: readonly Choice[];
  // For a connector with no choices: a stream read only to show the app's store
  // opens.
  protected readonly probe?: string;
  // Streams whose rows belong to no account or collection: a narrowed import
  // cannot attribute them, so it leaves them out.
  protected abstract readonly unscoped: readonly string[];
  // File streams that copy the app's own store rather than attachments; they
  // load metadata only.
  protected abstract readonly storeCopies: readonly string[];

  protected readonly host: AppleHost;

  constructor(host: AppleHost, identity: ConnectorIdentity) {
    this.host = host;
    this.name = identity.name;
    this.title = identity.title;
    this.presetsFolder = join(identity.folder, 'presets');
  }

  // Read when asked, so a preset added to a user connector's folder is offered
  // without a restart.
  presets(): Preset[] {
    if (!existsSync(this.presetsFolder)) return [];
    return readdirSync(this.presetsFolder)
      .filter((file) => file.endsWith('.sql'))
      .sort()
      .map((file) => ({
        name: file.slice(0, -'.sql'.length),
        file: join(this.presetsFolder, file),
      }));
  }

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

  // Whose an error is to fix, as this connector's source classifies it.
  failureType(error: unknown): FailureType {
    return this.source(this.defaultScope()).failureType(error);
  }

  // What failed, and, when it is the user's to fix, what macOS access the app
  // needs. A failure the history or settings kept passes the type they
  // stored; null, for a stopped pass, has nothing for the user to fix.
  failure(
    error: unknown,
    failureType: FailureType | null = this.failureType(error),
  ): string {
    const message = error instanceof Error ? error.message : String(error);
    return failureType === 'config'
      ? `${message} — ${this.guidance()}`
      : message;
  }

  // What a selection of this connector covers, in a person's words.
  describe(scope: ImportScope): string {
    const parts = [
      ...this.choices.flatMap(({ scope: ids, title }) => {
        const count = scope[ids]?.length;
        if (count === undefined) return [];
        return [
          `${count} ${count === 1 ? title.replace(/(x)es$|s$/, '$1') : title}`,
        ];
      }),
      ...(scope.startAt ? [`from ${localDay(Date.parse(scope.startAt))}`] : []),
      // endAt is exclusive: the last day covered is the one before it.
      ...(scope.endAt
        ? [`until ${localDay(Date.parse(scope.endAt) - 1)}`]
        : []),
    ];
    return parts.length === 0 ? 'everything' : parts.join(', ');
  }

  // The connector's title and what a selection of it covers, as one phrase.
  titled(scope: ImportScope): string {
    const covers = this.describe(scope);
    return covers === 'everything' ? this.title : `${this.title} (${covers})`;
  }

  // The reader view of a stream: raw_inlineAttachments reads as
  // inline_attachments.
  view(stream: string): string {
    return stream.replaceAll(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  }

  // The rows of the streams this connector can be narrowed by. Opening the
  // app's store is also what makes macOS ask for access, so a denial fails
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
      if (!('type' in message) && message.stream !== this.probe)
        rows.set(message.stream, [
          ...(rows.get(message.stream) ?? []),
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- every Apple source validates its records against the stream's object schema
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

  // One pass of this connector's import, as every host runs it inside the
  // import's flight: stopped once the user removes the connector, its
  // connection failure kept in the settings and its outcome in the import's
  // sync history.
  async import(
    settings: Settings,
    selection: Selection,
    history: SQLiteSyncHistory,
  ): Promise<ImportOutcome> {
    using removal = settings.removal(selection);
    let built;
    try {
      built = await this.connection(settings.directory(selection), selection);
    } catch (error) {
      settings.saveConnectionFailure(
        selection,
        error instanceof Error ? error.message : String(error),
        this.failureType(error),
      );
      return { status: 'unconnected', error };
    }
    settings.clearConnectionFailure(selection);
    const { connection, destination } = built;
    await history.install([destination]);
    installSQLiteCatalog(destination);
    try {
      await new Pipeline({ connections: [connection], history }).run({
        signal: removal.signal,
      });
    } catch (error) {
      if (error instanceof ConnectorRemovedError) return { status: 'removed' };
      // The history recorded what each copy did not load.
      if (!(error instanceof PipelineError)) throw error;
    }
    return { status: 'imported' };
  }

  // The connector's streams, loaded incrementally into raw_<stream> tables of
  // the import directory's data.sqlite and read through documented views, with
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

// The calendar day an instant falls on, on the clock of the Mac the host
// runs on, which is the clock a person picks the days of a selection by.
function localDay(epochMilliseconds: number): string {
  const instant = new Date(epochMilliseconds);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${instant.getFullYear()}-${pad(instant.getMonth() + 1)}-${pad(instant.getDate())}`;
}
