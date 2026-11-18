import {
  Catalog,
  type ChangeSignal,
  type CopyConfiguration,
  type ExtractionCoverage,
  type Partition,
  Source,
  type SourceMessage,
  type Stream,
} from '@eltjs/elt';
import {
  SharePointAccessError,
  type SharePointClient,
  SharePointCredentialsError,
  SharePointSiteNotFoundError,
  SiteVersion,
} from '@eltjs/sdk-microsoft-sharepoint';

import {
  SharePointFolderNotFoundError,
  type SharePointSite,
} from './folder-scope.ts';
import { SharePointRun } from './sharepoint-run.ts';
import type { SharePointStream } from './sharepoint-stream.ts';
import { AccessRequestsStream } from './streams/access-requests-stream.ts';
import { DriveItemsStream } from './streams/drive-items-stream.ts';
import { DrivesStream } from './streams/drives-stream.ts';
import { ListColumnsStream } from './streams/list-columns-stream.ts';
import { ListItemsStream } from './streams/list-items-stream.ts';
import { ListsStream } from './streams/lists-stream.ts';
import { PagesStream } from './streams/pages-stream.ts';
import { SitesStream } from './streams/sites-stream.ts';

const readers = {
  sites: new SitesStream(),
  drives: new DrivesStream(),
  driveItems: new DriveItemsStream(),
  lists: new ListsStream(),
  listColumns: new ListColumnsStream(),
  listItems: new ListItemsStream(),
  accessRequests: new AccessRequestsStream(),
  pages: new PagesStream(),
} satisfies Record<string, SharePointStream>;
const catalog = new Catalog(
  Object.values(readers).map((reader) => reader.stream),
);
const readersByStream = new Map<Stream, SharePointStream>(
  Object.values(readers).map((reader) => [reader.stream, reader]),
);

export { SharePointFolderNotFoundError, type SharePointSite };

/**
 * The streams that load nothing for a site limited to folders, since no
 * record of them shows which folder holds it.
 */
export const restrictedSharePointStreams = Object.values(readers)
  .filter((reader) => reader.restricted)
  .map((reader) => reader.stream.name);

// How often a watch reads the version of each site, and how long one read,
// three requests to Graph with their retries, can take.
const checkIntervalMs = 60_000;
const checkTimeoutMs = 30_000;

export type SharePointSourceOptions = {
  readonly client: SharePointClient;
  // The sites, by URL, such as https://contoso.sharepoint.com/sites/Sales, or
  // by URL with the folders that limit them. A Sites.Selected app cannot list
  // its sites, so the host names them.
  readonly sites: readonly SharePointSite[];
};

/**
 * Reads the files, lists and pages of SharePoint Online sites through
 * Microsoft Graph, as one app. Each stream is read once for each configured
 * site, its partition.
 */
export class SharePointSource extends Source<SharePointRun> {
  readonly identity: string;
  protected readonly catalog = catalog;
  readonly sites = readers.sites.stream;
  readonly drives = readers.drives.stream;
  readonly driveItems = readers.driveItems.stream;
  readonly lists = readers.lists.stream;
  readonly listColumns = readers.listColumns.stream;
  readonly listItems = readers.listItems.stream;
  readonly accessRequests = readers.accessRequests.stream;
  readonly pages = readers.pages.stream;

  readonly #client: SharePointClient;
  readonly #siteUrls: readonly string[];
  // The folder URLs of each site that the host limited to folders.
  readonly #folders: ReadonlyMap<string, readonly string[]>;

  constructor({ client, sites }: SharePointSourceOptions) {
    super();
    if (sites.length === 0)
      throw new TypeError('SharePoint requires one site URL or more');
    // The sites are partitions, with a checkpoint each, so they are not part
    // of the identity: adding a site keeps the checkpoints of the others.
    this.identity = `sharepoint:${client.tenantId}`;
    this.#client = client;
    this.#siteUrls = Object.freeze(
      sites.map((site) => (typeof site === 'string' ? site : site.url)),
    );
    if (new Set(this.#siteUrls).size !== this.#siteUrls.length)
      throw new TypeError('SharePoint names each site URL once');
    const folders = new Map<string, readonly string[]>();
    for (const site of sites) {
      if (typeof site === 'string') continue;
      if (site.folders.length === 0)
        throw new TypeError(
          `SharePoint site ${site.url} names no folder; name the site by its URL alone to load all of it`,
        );
      folders.set(site.url, Object.freeze([...site.folders]));
    }
    this.#folders = folders;
    Object.freeze(this);
  }

  protected override readonly configErrors = [
    SharePointAccessError,
    SharePointCredentialsError,
    SharePointSiteNotFoundError,
    SharePointFolderNotFoundError,
  ];

  protected override partitions(): readonly Partition[] {
    return this.#siteUrls.map((siteUrl) => ({ siteUrl }));
  }

  protected override open(): Promise<SharePointRun> {
    return SharePointRun.open(this.#client, this.#folders);
  }

  override coverage(stream: Stream): ExtractionCoverage {
    const reader = this.#reader(stream);
    return {
      description: reader.restricted
        ? `${reader.covers} A site limited to folders loads none of it.`
        : reader.covers,
      selection: {
        sites: [...this.#siteUrls],
        folders: Object.fromEntries(
          [...this.#folders].map(([site, urls]) => [site, [...urls]]),
        ),
      },
    };
  }

  override async currentAsOf(): Promise<Date | null> {
    return null;
  }

  // Graph sends change notifications only to a public URL, so a watch reads
  // the version of each site, which moves when a list, a library or a page
  // of it changes.
  override changeSignals(streams: readonly Stream[]): ChangeSignal[] {
    return this.#siteUrls.map((url) => ({
      gauge: new SiteVersion(this.#client, url),
      streams,
      interval: checkIntervalMs,
      timeout: checkTimeoutMs,
    }));
  }

  protected override extract(
    configuration: CopyConfiguration,
    state: unknown,
    partition: Partition | null,
    run: SharePointRun,
    signal: AbortSignal | undefined,
  ): AsyncIterable<SourceMessage> {
    const siteUrl = partition?.siteUrl;
    if (typeof siteUrl !== 'string')
      throw new TypeError(
        `SharePoint stream ${configuration.stream.name} is read once for each site`,
      );
    return this.#reader(configuration.stream).extract(
      configuration,
      state,
      siteUrl,
      run,
      signal ?? new AbortController().signal,
    );
  }

  #reader(stream: Stream): SharePointStream {
    const reader = readersByStream.get(stream);
    if (reader === undefined)
      throw new TypeError(`SharePoint has no stream ${stream.name}`);
    return reader;
  }
}
