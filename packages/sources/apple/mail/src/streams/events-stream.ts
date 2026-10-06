import { eventsTable } from '@workspace/sdk-apple-mail';

import type { MailSelection } from '../mail-selection.ts';
import { MailTableStream } from '../mail-table-stream.ts';

export class EventsStream extends MailTableStream<typeof eventsTable> {
  readonly name = 'events';

  constructor() {
    super(
      eventsTable,
      'One record per event row the local Mail index stores for a message. Primary key id. messageId refers to messages.id, the local id, not the Message-ID hash. startDateRaw and endDateRaw keep stored numbers because their date epoch is unverified.',
      {
        ROWID: 'Local event row identifier.',
        message_id:
          'Refers to messages.id within this source (the local id, not messages.messageId).',
      },
    );
  }

  protected accepts(
    record: Record<string, unknown>,
    selection: MailSelection,
  ): boolean {
    return selection.message(record.messageId);
  }
}
