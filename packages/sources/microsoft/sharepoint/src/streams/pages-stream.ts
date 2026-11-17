import type { RecordDraft } from '@eltjs/elt';

import type { SharePointRun } from '../sharepoint-run.ts';
import {
  createdBy,
  instant,
  json,
  lastModifiedBy,
  nullableInstant,
  sharePointFields,
  siteUrl,
} from '../sharepoint-stream.ts';
import { SnapshotStream } from '../snapshot-stream.ts';

const { id, text, nullableText, timestamp, nullableTimestamp } =
  sharePointFields;

const properties = {
  siteUrl,
  pageId: { ...id, description: "Graph's ID of the page." },
  name: {
    ...text,
    description: 'The file name of the page, such as Home.aspx.',
  },
  title: { ...text, description: 'The title of the page.' },
  description: {
    ...nullableText,
    description: 'The description of the page. NULL when it has none.',
  },
  webUrl: { ...text, description: 'The URL of the page.' },
  pageLayout: {
    ...nullableText,
    description:
      'The layout of the page, such as article or home. NULL when Graph gives none.',
  },
  eTag: {
    ...nullableText,
    description:
      'The version tag of the page, which changes when the page changes. NULL when Graph gives none.',
  },
  createdDateTime: {
    ...nullableTimestamp,
    description:
      'When the page was created, in UTC. NULL when Graph gives none.',
  },
  lastModifiedDateTime: {
    ...timestamp,
    description: 'When the page last changed, in UTC.',
  },
  createdBy,
  lastModifiedBy,
  publishingLevel: {
    ...nullableText,
    description:
      'Whether the page is published or a draft: published, draft or checkout. NULL when Graph gives none.',
  },
  publishingVersion: {
    ...nullableText,
    description:
      'The version of the page, such as 2.0 for a published page. NULL when Graph gives none.',
  },
  html: {
    ...nullableText,
    description:
      'The HTML that people wrote on the page: the inner HTML of each text web part, in the order of the canvas, one after the other on its own line. Images, embedded documents and other web parts give no text. NULL when the page has no text web part.',
  },
} as const;

export class PagesStream extends SnapshotStream {
  constructor() {
    super({
      name: 'pages',
      description:
        'One record for each modern page of the Site Pages library of the site, with the HTML of its text web parts. Primary key siteUrl, pageId. An incremental read deletes a page that Graph no longer lists.',
      properties,
      primaryKey: ['siteUrl', 'pageId'],
      covers:
        'Every modern page of each configured site, and the text web parts of each page.',
    });
  }

  protected async *scan(
    url: string,
    run: SharePointRun,
    signal: AbortSignal,
  ): AsyncGenerator<RecordDraft<typeof properties>> {
    const { id: siteId } = await run.site(url, signal);
    for (const page of await run.client.pages(siteId, signal)) {
      const parts = await run.client.textWebParts(siteId, page.id, signal);
      yield {
        siteUrl: url,
        pageId: page.id,
        name: page.name,
        title: page.title,
        description: page.description ?? null,
        webUrl: page.webUrl,
        pageLayout: page.pageLayout ?? null,
        eTag: page.eTag ?? null,
        createdDateTime: nullableInstant(page.createdDateTime),
        lastModifiedDateTime: instant(page.lastModifiedDateTime),
        createdBy: json(page.createdBy),
        lastModifiedBy: json(page.lastModifiedBy),
        publishingLevel: page.publishingState?.level ?? null,
        publishingVersion: page.publishingState?.versionId ?? null,
        html:
          parts.length === 0
            ? null
            : parts.map((part) => part.innerHtml).join('\n'),
      };
    }
  }
}
