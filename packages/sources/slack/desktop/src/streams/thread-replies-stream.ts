import type { RecordDraft } from '@workspace/elt';
import type { SlackMessage } from '@workspace/sdk-slack-desktop';

import type { SlackDesktopScan } from '../slack-desktop-scan.ts';
import { SlackDesktopStream } from '../slack-desktop-stream.ts';
import { messageProperties, messageRecord } from './message-fields.ts';

type Row = { readonly workspaceId: string; readonly message: SlackMessage };

// The app loads a thread's replies when it is opened and records no range of
// them, so a reply it no longer holds may have been deleted or only dropped
// from its cache: like a forgetting upstream, the stream deletes none.
export class ThreadRepliesStream extends SlackDesktopStream<
  typeof messageProperties,
  Row
> {
  readonly name = 'threadReplies';
  readonly primaryKey = ['workspaceId', 'channelId', 'ts'];
  override readonly emitsDeletes = undefined;
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per thread reply the app has held, which it loads when a thread is opened; threadTs is the parent in messages. Primary key workspaceId, channelId, ts. A reply stays after the app drops it, whether it was deleted or only left the cache: the app records no range of a thread to tell the two apart.',
    properties: messageProperties,
    required: Object.keys(messageProperties),
  } as const;

  protected rows(scan: SlackDesktopScan): readonly Row[] {
    return scan.clients.flatMap((client) =>
      scan
        .threadReplies(client)
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
