import {
  Catalog,
  type CopyConfiguration,
  type ExtractionCoverage,
  Source,
  type SourceMessage,
  Stream,
  diffSnapshot,
  validateRecords,
} from '@eltjs/elt';
import { DiaArchive, DiaArchiveMissingError } from '@eltjs/sdk-dia-desktop';
import {
  type ImportScope,
  selected,
  withinDates,
} from '@eltjs/source-apple-macos/import-scope';

const text = { type: 'string' } as const;
const nullableText = { type: ['string', 'null'] } as const;

const archivedTabs = new Stream({
  name: 'archivedTabs',
  jsonSchema: {
    type: 'object',
    description:
      'The tabs Dia archived, from every profile. Dia removes an archived tab after an age, when the user restores it, or when the user deletes it, and records none of these, so a row stays after Dia removes its tab.',
    properties: {
      profileId: {
        ...text,
        minLength: 1,
        description:
          'The Chromium profile folder of the tab’s profile, such as Default or Profile 1; the profile id of source-chromium-browser’s profiles stream.',
      },
      id: { ...text, minLength: 1, description: 'The tab’s UUID.' },
      title: { ...text, description: 'The tab’s title when Dia archived it.' },
      kind: {
        ...text,
        description:
          'The case of the tab’s variant: webContent for a web page, supertab for a Dia supertab.',
      },
      url: {
        ...nullableText,
        description: 'The page’s URL; null for a supertab, which has none.',
      },
      archivedAt: {
        ...text,
        format: 'date-time',
        precision: 6,
        description: 'When Dia archived the tab, in UTC to the microsecond.',
      },
      spaceId: {
        ...text,
        description: 'The UUID of the Dia space that held the tab.',
      },
      groupId: {
        ...nullableText,
        description:
          'The UUID of the tab group that held the tab; null when it was in none.',
      },
      variant: {
        ...text,
        description:
          'The tab’s variant as JSON text with its keys sorted: {"webContent":{"_0":<url>}}, or {"supertab":{"_0":<UUID>,"_1":{"newTab":{}},"_2":<UUID>}}, whose fields Dia does not name.',
      },
    },
    required: [
      'profileId',
      'id',
      'title',
      'kind',
      'url',
      'archivedAt',
      'spaceId',
      'groupId',
      'variant',
    ],
  },
  primaryKey: ['profileId', 'id'],
  supportedSyncModes: ['full_refresh', 'incremental'],
  // Every read is the whole file, so incremental copies diff snapshots.
  sourceDefinedCursor: true,
});
const catalog = new Catalog([archivedTabs]);
// How often a watch checks the file for a write.
const pollIntervalMs = 1000;

// An archive date cut to the millisecond, the precision of an import's dates,
// so it compares with them as text.
const toMilliseconds = (instant: string) => `${instant.slice(0, 23)}Z`;

// Reads the tabs Dia archived, from its archive file in the home folder
// `home`. Dia's open tabs are in an encrypted database that this source does
// not read.
export class DiaDesktopSource extends Source<AsyncDisposableStack> {
  readonly identity = 'dia-desktop';
  protected readonly catalog = catalog;
  readonly archivedTabs = archivedTabs;
  readonly scope: ImportScope;
  readonly #archive: DiaArchive;

  constructor({ home, scope = {} }: { home: string; scope?: ImportScope }) {
    super();
    this.scope = scope;
    this.#archive = new DiaArchive(home);
    Object.freeze(this);
  }

  protected override async open(): Promise<AsyncDisposableStack> {
    return new AsyncDisposableStack();
  }

  protected override readonly configErrors = [DiaArchiveMissingError];

  override coverage(): ExtractionCoverage {
    return {
      description:
        'Every tab that Dia’s archive holds now, of the selected profiles and archive dates. Dia removes archived tabs after an age, and the rows of those tabs stay.',
      selection: this.scope,
    };
  }

  // Dia writes the file only while it runs, so the file is current as of
  // its last write.
  override currentAsOf(): Promise<Date> {
    return this.#archive.lastWrite();
  }

  // One file, so a write wakes the one stream; the snapshot diff writes
  // nothing when no tab changed.
  override changeSignals(streams: readonly Stream[]) {
    return [
      {
        gauge: this.#archive.version(),
        streams,
        interval: pollIntervalMs,
        // A local read: a check that takes the whole interval is stuck.
        timeout: pollIntervalMs,
      },
    ];
  }

  // No policy: Dia records no reason for a removal, so the diff never
  // deletes and every row it loaded stays.
  protected override async *extract(
    configuration: CopyConfiguration,
    state: unknown,
    _partition: null,
    _context: AsyncDisposableStack,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<SourceMessage> {
    const tabs = (await this.#archive.tabs()).filter(
      (tab) =>
        selected(this.scope.collectionIds, tab.profileId) &&
        withinDates(this.scope, toMilliseconds(tab.archivedAt)),
    );
    yield* diffSnapshot(
      configuration,
      validateRecords(archivedTabs, tabs, 'Dia'),
      state,
      { signal },
    );
  }
}
