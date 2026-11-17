import type { CopyConfiguration, SourceMessage } from '@eltjs/elt';
import type { DeltaPage, ListItem } from '@eltjs/sdk-microsoft-sharepoint';

import { DeltaStream } from '../delta-stream.ts';
import {
  accessRequestTemplate,
  listItemProperties,
  listItemRecord,
} from '../list-item-record.ts';
import type { SharePointRun } from '../sharepoint-run.ts';

export class ListItemsStream extends DeltaStream<ListItem> {
  constructor() {
    super({
      name: 'listItems',
      description:
        'One record for each item of each list of the site, the items of document libraries included, with the value of each column as JSON. The lists of the requests for access are in accessRequests. Primary key siteUrl, listId, itemId. Read through the list items delta of Graph: the first read loads every item, and later reads apply the changes and deletions after it.',
      properties: listItemProperties,
      primaryKey: ['siteUrl', 'listId', 'itemId'],
      covers:
        'Every item of every list of each configured site but the lists of the requests for access, then the changes that the list items delta of Graph reports.',
    });
  }

  protected async collections(
    url: string,
    run: SharePointRun,
    signal: AbortSignal,
  ): Promise<readonly string[]> {
    return (await run.lists(url, signal))
      .filter((list) => list.list.template !== accessRequestTemplate)
      .map((list) => list.id);
  }

  protected async *pages(
    url: string,
    listId: string,
    link: string | undefined,
    run: SharePointRun,
    signal: AbortSignal,
  ): AsyncGenerator<DeltaPage<ListItem>> {
    const { id: siteId } = await run.site(url, signal);
    yield* run.client.listItemsDelta(siteId, listId, link, signal);
  }

  protected async *messages(
    configuration: CopyConfiguration,
    url: string,
    listId: string,
    item: ListItem,
  ): AsyncGenerator<SourceMessage> {
    if (item.deleted !== undefined) {
      yield* this.deletion(configuration, {
        siteUrl: url,
        listId,
        itemId: item.id,
      });
      return;
    }
    yield {
      stream: this.stream.name,
      data: this.validated(listItemRecord(url, listId, item)),
    };
  }
}
