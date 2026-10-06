import { messageGlobalDataTable } from '@workspace/sdk-apple-mail';

import type { MailSelection } from '../mail-selection.ts';
import { MailTableStream } from '../mail-table-stream.ts';

export class MessageGlobalDataStream extends MailTableStream<
  typeof messageGlobalDataTable
> {
  readonly name = 'messageGlobalData';

  constructor() {
    super(
      messageGlobalDataTable,
      'One record per message global data row in the local Mail index. Primary key id. messages.globalMessageId and messageRichLinks.globalMessageId refer to id; messageId holds the Message-ID hash of messages.messageId; generatedSummary refers to generatedSummaries.id. Raw-suffixed numbers keep their stored values because their date epoch is unverified.',
      {
        ROWID:
          'Local identifier; messages.globalMessageId and messageRichLinks.globalMessageId refer to it within this source.',
        message_id:
          'Message-ID hash, the same value as messages.messageId within this source; unique in the captured index schema.',
        generated_summary:
          'Refers to generatedSummaries.id within this source.',
      },
    );
  }

  protected accepts(
    record: Record<string, unknown>,
    selection: MailSelection,
  ): boolean {
    return selection.globalMessage(record.id);
  }
}
