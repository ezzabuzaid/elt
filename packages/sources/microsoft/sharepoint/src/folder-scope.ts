import {
  type Drive,
  GraphError,
  type PresentDriveItem,
  type SharePointClient,
} from '@eltjs/sdk-microsoft-sharepoint';

/**
 * A site of the source: its URL, which loads the whole site, or its URL with
 * the full URLs of folders in its document libraries, such as
 * https://contoso.sharepoint.com/sites/Sales/Shared Documents/Proposals,
 * which loads only those folders and what they hold.
 */
export type SharePointSite =
  | string
  | {
      readonly url: string;
      readonly folders: readonly [string, ...string[]];
    };

/** A scope folder as the host named it, and as Graph knows it now. */
export type ScopeFolder = {
  readonly url: string;
  readonly driveId: string;
  readonly item: PresentDriveItem;
};

/** What a read of a site covers: the whole site, or its scope folders. */
export type SiteScope = 'site' | readonly ScopeFolder[];

/**
 * No folder of the site is at a URL that the host named: no document library
 * of the site holds the URL, or no folder is at its path, for example after
 * someone renamed or moved it.
 */
export class SharePointFolderNotFoundError extends Error {
  override readonly name = 'SharePointFolderNotFoundError';
  readonly url: string;

  constructor(url: string, options?: { cause: GraphError }) {
    super(
      `No folder of the SharePoint site is at ${url}. Name a folder in a document library of the site, as its URL shows it in the browser.`,
      options,
    );
    this.url = url;
  }
}

// The host and the path of a URL without its encoding, so that a URL with
// spaces and one with %20 name the same folder.
function location(url: string): string {
  const parsed = new URL(url);
  return `${parsed.host}${decodeURIComponent(parsed.pathname)}`.replace(
    /\/+$/,
    '',
  );
}

/**
 * The folder at each URL: the library whose URL starts it, and the item at
 * the rest of its path. SharePoint matches URLs without regard to case.
 */
export async function resolveFolders(
  client: SharePointClient,
  drives: readonly Drive[],
  urls: readonly string[],
  signal: AbortSignal,
): Promise<readonly ScopeFolder[]> {
  const folders: ScopeFolder[] = [];
  for (const url of urls) {
    const target = location(url);
    const drive = drives.find((it) =>
      target.toLowerCase().startsWith(`${location(it.webUrl).toLowerCase()}/`),
    );
    if (drive === undefined) throw new SharePointFolderNotFoundError(url);
    const path = target.slice(location(drive.webUrl).length + 1);
    const item = await client
      .driveItemAt(drive.id, path, signal)
      .catch((error: unknown) => {
        if (error instanceof GraphError && error.status === 404)
          throw new SharePointFolderNotFoundError(url, { cause: error });
        throw error;
      });
    if (item.folder === undefined) throw new SharePointFolderNotFoundError(url);
    folders.push({ url, driveId: drive.id, item });
  }
  return folders;
}
