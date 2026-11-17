import type { RecordDraft } from '@eltjs/elt';

import type { SharePointRun } from '../sharepoint-run.ts';
import { json, sharePointFields, siteUrl } from '../sharepoint-stream.ts';
import { SnapshotStream } from '../snapshot-stream.ts';

const { id, text, nullableText, boolean } = sharePointFields;

const properties = {
  siteUrl,
  listId: { ...id, description: 'The list of the column: lists.listId.' },
  columnId: {
    ...id,
    description:
      "Graph's ID of the column. A site column has the same ID in each list that uses it.",
  },
  name: {
    ...text,
    description:
      'The name of the column: the key of its value in the fields of listItems and accessRequests.',
  },
  displayName: { ...text, description: 'The title of the column.' },
  description: {
    ...nullableText,
    description: 'The description of the column. NULL when nobody wrote one.',
  },
  columnGroup: {
    ...nullableText,
    description: 'The group of the column. NULL when it has none.',
  },
  hidden: {
    ...boolean,
    description: 'Whether SharePoint hides the column from forms.',
  },
  indexed: { ...boolean, description: 'Whether the column is indexed.' },
  readOnly: { ...boolean, description: 'Whether nobody can edit the column.' },
  required: { ...boolean, description: 'Whether each item needs a value.' },
  enforceUniqueValues: {
    ...boolean,
    description: 'Whether no two items can have the same value.',
  },
  type: {
    ...nullableText,
    description:
      'The type of the column, as the facet of Graph: text, choice, number, dateTime, lookup, personOrGroup, boolean, calculated, currency, geolocation, hyperlinkOrPicture, term, thumbnail or contentApprovalStatus. NULL for a type that Graph does not model.',
  },
  settings: {
    ...nullableText,
    description:
      'The settings of the type as JSON, such as the choices of a choice column. NULL for a type that Graph does not model.',
  },
} as const;

export class ListColumnsStream extends SnapshotStream {
  constructor() {
    super({
      name: 'listColumns',
      description:
        'One record for each column of each list of the site that is not hidden from Graph. Primary key siteUrl, listId, columnId. An incremental read deletes a column that Graph no longer lists.',
      properties,
      primaryKey: ['siteUrl', 'listId', 'columnId'],
      covers:
        'The columns of every list of each configured site, as Graph lists them.',
    });
  }

  protected async *scan(
    url: string,
    run: SharePointRun,
    signal: AbortSignal,
  ): AsyncGenerator<RecordDraft<typeof properties>> {
    const { id: siteId } = await run.site(url, signal);
    for (const list of await run.lists(url, signal))
      for (const column of await run.client.columns(siteId, list.id, signal))
        yield {
          siteUrl: url,
          listId: list.id,
          columnId: column.id,
          name: column.name,
          displayName: column.displayName,
          description: column.description ?? null,
          columnGroup: column.columnGroup ?? null,
          hidden: column.hidden,
          indexed: column.indexed,
          readOnly: column.readOnly,
          required: column.required,
          enforceUniqueValues: column.enforceUniqueValues,
          type: column.type?.name ?? null,
          settings: json(column.type?.settings),
        };
  }
}
