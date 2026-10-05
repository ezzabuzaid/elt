import {
  type ChatDatabase,
  type ChatValues,
  handleTable,
} from '@workspace/sdk-apple-messages';

import { AppleMessagesStream } from '../apple-messages-stream.ts';
import {
  localStore,
  provenance,
  tableFields,
  tableRecord,
  unverified,
} from '../messages-fields.ts';
import type { MessageSelection } from '../messages-scan.ts';

const properties = tableFields(handleTable, {
  id: `${provenance(handleTable, 'id')} Unique only together with service: the same id can recur under another service. messages.handle, messages.otherHandle and chatHandles.handleId refer to it within this source, each together with its service field. ${unverified}`,
  service: `${provenance(handleTable, 'service')} The second half of this stream's composite key (id, service). messages.handleService, messages.otherHandleService and chatHandles.handleService refer to it within this source. ${unverified}`,
});

export class HandlesStream extends AppleMessagesStream<ChatValues> {
  readonly name = 'handles';
  readonly primaryKey = ['id', 'service'];
  readonly jsonSchema = {
    type: 'object',
    description: `One record per handle in chat.db's handle table, keyed by the composite (id, service): the same id can appear once per service, so every join uses both fields. messages.handle and messages.handleService join handles.id and handles.service, likewise messages.otherHandle and messages.otherHandleService; chatHandles joins by handleId and handleService. ${localStore}`,
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(database: ChatDatabase): readonly ChatValues[] {
    return database.handles();
  }

  protected accepts(row: ChatValues, selection: MessageSelection): boolean {
    return selection.handle(row.id, row.service);
  }

  protected records(row: ChatValues): Record<string, unknown>[] {
    return [tableRecord(handleTable, row)];
  }
}
