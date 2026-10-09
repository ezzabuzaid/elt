import type { KeyValue, RecordDraft } from '@workspace/elt';
import type { SlackMessage } from '@workspace/sdk-slack-desktop';

import type { SlackDesktopScan } from '../slack-desktop-scan.ts';
import { SlackDesktopStream } from '../slack-desktop-stream.ts';
import { messageProperties, messageRecord } from './message-fields.ts';

type Row = { readonly workspaceId: string; readonly message: SlackMessage };

export class MessagesStream extends SlackDesktopStream<
  typeof messageProperties,
  Row
> {
  readonly name = 'messages';
  readonly primaryKey = ['workspaceId', 'channelId', 'ts'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per channel message the app has held: the app keeps only the parts of each conversation it loaded, so older history is here only if it was loaded while this import ran. Thread replies are in threadReplies. Primary key workspaceId, channelId, ts. A message the app no longer lists inside a part of the conversation it still holds was deleted and is deleted here; one the app dropped from its cache stays.',
    properties: messageProperties,
    required: Object.keys(messageProperties),
  } as const;

  override covers(
    scan: SlackDesktopScan,
    key: Readonly<Record<string, KeyValue>>,
  ): boolean {
    return scan.holds(key.workspaceId, key.channelId, key.ts);
  }

  protected rows(scan: SlackDesktopScan): readonly Row[] {
    return scan.clients.flatMap((client) =>
      scan
        .messages(client)
        .map((message) => ({ workspaceId: client.workspace.id, message })),
    );
  }

  protected records({
    workspaceId,
    message,
  }: Row): RecordDraft<typeof messageProperties>[] {
    return [messageRecord(workspaceId, message)];
  }
}
