import { rm } from 'node:fs/promises';

import {
  type CopyConfiguration,
  type RecordDraft,
  type SourceMessage,
  fileExtension,
} from '@eltjs/elt';
import {
  type DeltaPage,
  type DriveItem,
  GraphError,
  type PresentDriveItem,
} from '@eltjs/sdk-microsoft-sharepoint';

import { DeltaStream } from '../delta-stream.ts';
import type { SharePointRun } from '../sharepoint-run.ts';
import {
  createdBy,
  instant,
  json,
  lastModifiedBy,
  sharePointFields,
  siteUrl,
} from '../sharepoint-stream.ts';

const { id, text, nullableText, boolean, timestamp, count, nullableCount } =
  sharePointFields;

const properties = {
  siteUrl,
  driveId: {
    ...id,
    description: 'The document library of the item: drives.driveId.',
  },
  itemId: { ...id, description: "Graph's ID of the file or the folder." },
  name: {
    ...text,
    description: 'The name of the file or the folder, with its extension.',
  },
  isFolder: { ...boolean, description: 'Whether the item is a folder.' },
  size: {
    ...count,
    description:
      'The size in bytes: of the file, or of every file in the folder.',
  },
  mimeType: {
    ...nullableText,
    description: 'The media type of the file. NULL for a folder.',
  },
  quickXorHash: {
    ...nullableText,
    description:
      'The quickXorHash of the content, in base64. NULL for a folder, or when Graph gives none.',
  },
  sha1Hash: {
    ...nullableText,
    description:
      'The SHA-1 of the content, in hex. NULL when Graph gives none, as for most files of SharePoint.',
  },
  sha256Hash: {
    ...nullableText,
    description:
      'The SHA-256 of the content, in hex. NULL when Graph gives none, as for most files of SharePoint.',
  },
  childCount: {
    ...nullableCount,
    description: 'How many items the folder holds. NULL for a file.',
  },
  parentId: {
    ...nullableText,
    description:
      'The folder that holds the item: its itemId. The root folder of the library has no row.',
  },
  path: {
    ...nullableText,
    description:
      'The path of the folder that holds the item, as Graph gives it, such as /drives/<driveId>/root:/02 BD Resources. NULL when the delta of Graph leaves it out.',
  },
  webUrl: { ...text, description: 'The URL of the file or the folder.' },
  createdDateTime: {
    ...timestamp,
    description: 'When the item was created, in UTC.',
  },
  lastModifiedDateTime: {
    ...timestamp,
    description: 'When the item last changed, in UTC.',
  },
  createdBy,
  lastModifiedBy,
  eTag: {
    ...nullableText,
    description:
      'The version tag of the item, which changes when its content or its metadata changes. NULL when Graph gives none.',
  },
  cTag: {
    ...nullableText,
    description:
      'The version tag of the content of the item, which changes only when the content changes. NULL when the delta of Graph leaves it out.',
  },
  listItemId: {
    ...nullableText,
    description:
      'The item of the library list that holds the metadata columns of the file or the folder: listItems.itemId of the list of the library. NULL when Graph gives none.',
  },
} as const;

export class DriveItemsStream extends DeltaStream<DriveItem> {
  constructor() {
    super({
      name: 'driveItems',
      description:
        'One record for each file and folder of each document library of the site, without the root folder of the library, which drives describes. A copy can take the content of a file through the file of the stream; a field that accepts only some file names downloads only those files. Primary key siteUrl, driveId, itemId. Read through the drive delta of Graph: the first read loads every item, and later reads apply the changes and deletions after it.',
      properties,
      primaryKey: ['siteUrl', 'driveId', 'itemId'],
      covers:
        'Every file and folder of every document library of each configured site, then the changes that the drive delta of Graph reports.',
      supportsFileTransfer: true,
    });
  }

  protected async collections(
    url: string,
    run: SharePointRun,
    signal: AbortSignal,
  ): Promise<readonly string[]> {
    return (await run.drives(url, signal)).map((drive) => drive.id);
  }

  protected pages(
    _url: string,
    driveId: string,
    link: string | undefined,
    run: SharePointRun,
    signal: AbortSignal,
  ): AsyncIterable<DeltaPage<DriveItem>> {
    return run.client.driveDelta(driveId, link, signal);
  }

  protected async *messages(
    configuration: CopyConfiguration,
    url: string,
    driveId: string,
    item: DriveItem,
    run: SharePointRun,
    signal: AbortSignal,
  ): AsyncGenerator<SourceMessage> {
    if (item.deleted !== undefined) {
      yield* this.deletion(configuration, {
        siteUrl: url,
        driveId,
        itemId: item.id,
      });
      return;
    }
    // A delta gives the root folder of the drive on each of its pages (live,
    // 2026-11-17: 31 times over 31 pages), with no eTag and no author.
    if (item.root !== undefined) return;
    const data = this.validated(record(url, driveId, item));
    if (configuration.fileReads.length === 0) {
      yield { stream: this.stream.name, data };
      return;
    }
    const file =
      item.file !== undefined &&
      configuration.fileReads.some((read) => read.accepts(item.name))
        ? await download(run, driveId, item, signal)
        : null;
    try {
      yield { stream: this.stream.name, data, file };
    } finally {
      if (file !== null) await rm(file, { force: true });
    }
  }
}

function record(
  url: string,
  driveId: string,
  item: PresentDriveItem,
): RecordDraft<typeof properties> {
  return {
    siteUrl: url,
    driveId,
    itemId: item.id,
    name: item.name,
    isFolder: item.folder !== undefined,
    size: item.size,
    mimeType: item.file?.mimeType ?? null,
    quickXorHash: item.file?.hashes?.quickXorHash ?? null,
    sha1Hash: item.file?.hashes?.sha1Hash ?? null,
    sha256Hash: item.file?.hashes?.sha256Hash ?? null,
    childCount: item.folder?.childCount ?? null,
    parentId: item.parentReference.id ?? null,
    path: item.parentReference.path ?? null,
    webUrl: item.webUrl,
    createdDateTime: instant(item.createdDateTime),
    lastModifiedDateTime: instant(item.lastModifiedDateTime),
    createdBy: json(item.createdBy),
    lastModifiedBy: json(item.lastModifiedBy),
    eTag: item.eTag ?? null,
    cTag: item.cTag ?? null,
    listItemId: item.sharepointIds?.listItemId ?? null,
  };
}

// The content of a file, staged in the run's folder under its item ID and
// the extension of its name, which a parser reads the format from. null when
// the file was deleted after the delta listed it: the next delta gives its
// deletion.
async function download(
  run: SharePointRun,
  driveId: string,
  item: PresentDriveItem,
  signal: AbortSignal,
): Promise<string | null> {
  const path = run.staged(`${item.id}${fileExtension(item.name)}`);
  try {
    await run.client.download(driveId, item.id, path, signal);
    return path;
  } catch (error) {
    if (error instanceof GraphError && error.status === 404) return null;
    throw error;
  }
}
