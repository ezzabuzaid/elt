import type { RecordDraft } from '@eltjs/elt';

import type { SharePointRun } from '../sharepoint-run.ts';
import { instant, sharePointFields, siteUrl } from '../sharepoint-stream.ts';
import { SnapshotStream } from '../snapshot-stream.ts';

const { id, text, nullableText, timestamp } = sharePointFields;

const properties = {
  siteUrl,
  driveId: {
    ...id,
    description:
      "Graph's ID of the document library. driveItems.driveId refers to it.",
  },
  name: { ...text, description: 'The name of the document library.' },
  description: {
    ...nullableText,
    description:
      'The description of the document library. NULL when nobody wrote one.',
  },
  driveType: {
    ...text,
    description: 'The kind of drive: documentLibrary for a SharePoint library.',
  },
  webUrl: { ...text, description: 'The URL of the document library.' },
  createdDateTime: {
    ...timestamp,
    description: 'When the document library was created, in UTC.',
  },
  lastModifiedDateTime: {
    ...timestamp,
    description:
      'When a file or a folder of the document library last changed, in UTC.',
  },
} as const;

export class DrivesStream extends SnapshotStream {
  constructor() {
    super({
      name: 'drives',
      description:
        'One record for each document library of the site, as Graph shows it: a drive of files and folders. A site limited to folders loads only the libraries that hold them. Primary key siteUrl, driveId. An incremental read deletes a library that Graph no longer lists.',
      properties,
      primaryKey: ['siteUrl', 'driveId'],
      covers: 'Every document library of each configured site.',
    });
  }

  protected async *scan(
    url: string,
    run: SharePointRun,
    signal: AbortSignal,
  ): AsyncGenerator<RecordDraft<typeof properties>> {
    const scope = await run.scope(url, signal);
    for (const drive of await run.drives(url, signal))
      if (scope === 'site' || scope.some((it) => it.driveId === drive.id))
        yield {
          siteUrl: url,
          driveId: drive.id,
          name: drive.name,
          description: drive.description ?? null,
          driveType: drive.driveType,
          webUrl: drive.webUrl,
          createdDateTime: instant(drive.createdDateTime),
          lastModifiedDateTime: instant(drive.lastModifiedDateTime),
        };
  }
}
