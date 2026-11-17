import type { RecordDraft } from '@eltjs/elt';

import {
  accessRequestTemplate,
  listItemProperties,
  listItemRecord,
} from '../list-item-record.ts';
import type { SharePointRun } from '../sharepoint-run.ts';
import { SnapshotStream } from '../snapshot-stream.ts';

export class AccessRequestsStream extends SnapshotStream {
  constructor() {
    super({
      name: 'accessRequests',
      description:
        'One record for each item of the lists of the requests for access to the site (template accessRequest), with the value of each column as JSON, as listItems has. Graph serves no item delta for these lists, so each read lists their items in full. Primary key siteUrl, listId, itemId. An incremental read deletes an item that Graph no longer lists.',
      properties: listItemProperties,
      primaryKey: ['siteUrl', 'listId', 'itemId'],
      covers:
        'Every item of each list of the requests for access of each configured site.',
    });
  }

  protected async *scan(
    url: string,
    run: SharePointRun,
    signal: AbortSignal,
  ): AsyncGenerator<RecordDraft<typeof listItemProperties>> {
    const { id: siteId } = await run.site(url, signal);
    for (const list of await run.lists(url, signal))
      if (list.list.template === accessRequestTemplate)
        for (const item of await run.client.listItems(siteId, list.id, signal))
          yield listItemRecord(url, list.id, item);
  }
}
