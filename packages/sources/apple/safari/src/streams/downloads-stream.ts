import type { RecordDraft, SchemaRecord } from '@workspace/elt';
import type { Download } from '@workspace/sdk-apple-safari';

import type { SafariScan } from '../safari-scan.ts';
import { SafariStream, iso, safariFields } from '../safari-stream.ts';

const { boolean, nullableText, nullableTimestamp, nullableInteger } =
  safariFields;

const properties = {
  id: { ...safariFields.id, description: 'Download identifier.' },
  profileId: {
    ...safariFields.nullableId,
    description:
      'The profile that downloaded the file; refers to profiles.id. NULL when not recorded.',
  },
  url: { ...safariFields.text, description: 'URL the file came from.' },
  path: {
    ...safariFields.text,
    description:
      'Where Safari saved the file. For an archive Safari opened on its own, the archive inside a .download folder that no longer exists.',
  },
  openedPath: {
    ...nullableText,
    description:
      'For an archive Safari opened on its own, the first extracted file as Safari recorded it, inside the .download folder; Safari moves the extracted files next to it. NULL otherwise.',
  },
  addedAt: {
    ...nullableTimestamp,
    description: 'When the download started.',
  },
  finishedAt: {
    ...nullableTimestamp,
    description: 'When the download finished; NULL while unfinished.',
  },
  bytesReceived: {
    ...nullableInteger,
    description: 'Bytes downloaded.',
  },
  bytesTotal: {
    ...nullableInteger,
    description: 'Expected size in bytes, as Safari recorded it.',
  },
  removeWhenDone: {
    ...boolean,
    description: 'Whether Safari removes the entry once finished.',
  },
  availableLocally: {
    ...boolean,
    description: 'Whether the file at path exists on this Mac.',
  },
} as const;

export class DownloadsStream extends SafariStream<typeof properties, Download> {
  readonly name = 'downloads';
  readonly store = 'downloads';
  readonly primaryKey = ['id'];
  readonly supportsFileTransfer = true;
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per entry of the Safari Downloads list (Downloads.plist), with the downloaded file when it is still where Safari saved it. Clearing the list removes the entries, not the files. Relationships name streams in this source, not physical destination tables.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: SafariScan): readonly Download[] {
    return scan.downloads;
  }

  protected record(download: Download): RecordDraft<typeof properties> {
    return {
      id: download.id,
      profileId: download.profileId,
      url: download.url,
      path: download.path,
      openedPath: download.openedPath,
      addedAt: iso(download.addedAt),
      finishedAt: iso(download.finishedAt),
      bytesReceived: download.bytesReceived,
      bytesTotal: download.bytesTotal,
      removeWhenDone: download.removeWhenDone,
      availableLocally: download.availableLocally,
    };
  }

  // The original file, not a copy: downloads reach gigabytes and readers
  // only read it.
  override file(record: SchemaRecord<typeof properties>): string | null {
    return record.availableLocally ? record.path : null;
  }
}
