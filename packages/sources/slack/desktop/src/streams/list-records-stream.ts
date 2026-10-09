import type { RecordDraft } from '@workspace/elt';
import type { SlackListRecord } from '@workspace/sdk-slack-desktop';

import type { SlackDesktopScan } from '../slack-desktop-scan.ts';
import { SlackDesktopStream, slackFields } from '../slack-desktop-stream.ts';

const { id, nullableText, nullableBoolean, nullableTimestamp, nullableTs } =
  slackFields;

const properties = {
  workspaceId: { ...id, description: 'The workspace (workspaces.id).' },
  listId: { ...id, description: 'The List (files.id, mode list).' },
  id: { ...id, description: 'Slack’s row ID, such as Rec0123ABCD.' },
  position: {
    ...nullableText,
    description: 'The row’s sort key in the List; order rows by it as text.',
  },
  parentRecordId: {
    ...nullableText,
    description: 'For a subtask, its parent row (list_records.id).',
  },
  threadTs: {
    ...nullableTs,
    description: 'The thread of comments on the row, as a ts.',
  },
  createdAt: { ...nullableTimestamp, description: 'When the row was added.' },
  createdBy: { ...nullableText, description: 'Who added it (members.id).' },
  updatedAt: {
    ...nullableTimestamp,
    description: 'When it last changed.',
  },
  updatedBy: {
    ...nullableText,
    description: 'Who last changed it (members.id).',
  },
  isArchived: { ...nullableBoolean, description: 'Whether it was archived.' },
  fields: {
    ...nullableText,
    description:
      'Its cells as JSON keyed by column ID, as Slack holds them; files.listMetadata names each column under schema.',
  },
} as const;

type Row = { readonly workspaceId: string; readonly record: SlackListRecord };

// The app keeps the rows of the Lists it opened and may drop them; a removed
// row reads isArchived while held, so a row it drops stays.
export class ListRecordsStream extends SlackDesktopStream<
  typeof properties,
  Row
> {
  readonly name = 'listRecords';
  readonly primaryKey = ['workspaceId', 'listId', 'id'];
  override readonly emitsDeletes = undefined;
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per row of a Slack List the app has opened. Primary key workspaceId, listId, id. A row stays after the app drops it; one archived while held reads isArchived.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: SlackDesktopScan): readonly Row[] {
    return scan.clients.flatMap(({ workspace, listRecords }) =>
      listRecords.map((record) => ({ workspaceId: workspace.id, record })),
    );
  }

  protected records({
    workspaceId,
    record,
  }: Row): RecordDraft<typeof properties>[] {
    return [
      {
        workspaceId,
        listId: record.listId,
        id: record.id,
        position: record.position,
        parentRecordId: record.parentRecordId,
        threadTs: record.threadTs,
        createdAt: record.createdAt,
        createdBy: record.createdBy,
        updatedAt: record.updatedAt,
        updatedBy: record.updatedBy,
        isArchived: record.isArchived,
        fields: record.fieldsJson,
      },
    ];
  }
}
