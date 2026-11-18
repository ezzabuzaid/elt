import type { RecordDraft } from '@eltjs/elt';

import type { SharePointRun } from '../sharepoint-run.ts';
import { instant, sharePointFields, siteUrl } from '../sharepoint-stream.ts';
import { SnapshotStream } from '../snapshot-stream.ts';

const { id, text, nullableText, boolean, timestamp } = sharePointFields;

const properties = {
  siteUrl,
  listId: {
    ...id,
    description:
      "Graph's ID of the list. listColumns, listItems and accessRequests refer to it as listId.",
  },
  name: { ...text, description: 'The name of the list in its URL.' },
  displayName: { ...text, description: 'The title of the list.' },
  description: {
    ...nullableText,
    description: 'The description of the list. NULL when nobody wrote one.',
  },
  webUrl: { ...text, description: 'The URL of the list.' },
  template: {
    ...text,
    description:
      'What kind of list it is, such as genericList, events, documentLibrary (a document library, also in drives) or accessRequest (the requests for access to the site, read by accessRequests).',
  },
  hidden: {
    ...boolean,
    description: 'Whether SharePoint hides the list from the site contents.',
  },
  contentTypesEnabled: {
    ...boolean,
    description: 'Whether the list has content types of its own.',
  },
  createdDateTime: {
    ...timestamp,
    description: 'When the list was created, in UTC.',
  },
  lastModifiedDateTime: {
    ...timestamp,
    description: 'When the list or one of its items last changed, in UTC.',
  },
} as const;

export class ListsStream extends SnapshotStream {
  constructor() {
    super({
      name: 'lists',
      restricted: true,
      description:
        'One record for each list of the site, hidden lists and document libraries included. Graph leaves out the lists it marks system. Primary key siteUrl, listId. An incremental read deletes a list that Graph no longer lists.',
      properties,
      primaryKey: ['siteUrl', 'listId'],
      covers:
        'Every list of each configured site that Graph does not mark system.',
    });
  }

  protected async *scan(
    url: string,
    run: SharePointRun,
    signal: AbortSignal,
  ): AsyncGenerator<RecordDraft<typeof properties>> {
    for (const list of await run.lists(url, signal))
      yield {
        siteUrl: url,
        listId: list.id,
        name: list.name,
        displayName: list.displayName,
        description: list.description ?? null,
        webUrl: list.webUrl,
        template: list.list.template,
        hidden: list.list.hidden,
        contentTypesEnabled: list.list.contentTypesEnabled,
        createdDateTime: instant(list.createdDateTime),
        lastModifiedDateTime: instant(list.lastModifiedDateTime),
      };
  }
}
