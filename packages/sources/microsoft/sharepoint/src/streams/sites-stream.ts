import type { RecordDraft } from '@eltjs/elt';

import type { SharePointRun } from '../sharepoint-run.ts';
import { instant, sharePointFields, siteUrl } from '../sharepoint-stream.ts';
import { SnapshotStream } from '../snapshot-stream.ts';

const { id, text, nullableText, timestamp } = sharePointFields;

const properties = {
  siteUrl,
  siteId: {
    ...id,
    description:
      "Graph's ID of the site: <host>,<site collection ID>,<web ID>.",
  },
  name: { ...text, description: 'The name of the site in its URL.' },
  displayName: { ...text, description: 'The title of the site.' },
  description: {
    ...nullableText,
    description: 'The description of the site. NULL when nobody wrote one.',
  },
  webUrl: { ...text, description: 'The URL of the site that Graph gives.' },
  createdDateTime: {
    ...timestamp,
    description: 'When the site was created, in UTC.',
  },
  lastModifiedDateTime: {
    ...timestamp,
    description: 'When the site last changed, in UTC.',
  },
} as const;

export class SitesStream extends SnapshotStream {
  constructor() {
    super({
      name: 'sites',
      description:
        'One record for each configured site that the app can read. Primary key siteUrl, siteId. An incremental read deletes a site whose ID changed at its URL.',
      properties,
      primaryKey: ['siteUrl', 'siteId'],
      covers: 'The site at each configured URL.',
    });
  }

  protected async *scan(
    url: string,
    run: SharePointRun,
    signal: AbortSignal,
  ): AsyncGenerator<RecordDraft<typeof properties>> {
    const site = await run.site(url, signal);
    yield {
      siteUrl: url,
      siteId: site.id,
      name: site.name,
      displayName: site.displayName,
      description: site.description ?? null,
      webUrl: site.webUrl,
      createdDateTime: instant(site.createdDateTime),
      lastModifiedDateTime: instant(site.lastModifiedDateTime),
    };
  }
}
