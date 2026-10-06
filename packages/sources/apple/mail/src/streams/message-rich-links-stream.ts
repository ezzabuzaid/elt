import { messageRichLinksTable } from '@workspace/sdk-apple-mail';

import type { MailSelection } from '../mail-selection.ts';
import { MailTableStream } from '../mail-table-stream.ts';

export class MessageRichLinksStream extends MailTableStream<
  typeof messageRichLinksTable
> {
  readonly name = 'messageRichLinks';

  constructor() {
    super(
      messageRichLinksTable,
      'One record per message global data row and rich link pair. Primary key (globalMessageId, richLink). globalMessageId refers to messageGlobalData.id, reached from messages through messages.globalMessageId; richLink refers to richLinks.id. A message can have several links: count at message grain.',
      {
        global_message_id: 'Refers to messageGlobalData.id within this source.',
        rich_link: 'Refers to richLinks.id within this source.',
      },
    );
  }

  protected accepts(
    record: Record<string, unknown>,
    selection: MailSelection,
  ): boolean {
    return selection.globalMessage(record.globalMessageId);
  }
}
