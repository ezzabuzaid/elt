import { subjectsTable } from '@workspace/sdk-apple-mail';

import type { MailSelection } from '../mail-selection.ts';
import { MailTableStream } from '../mail-table-stream.ts';

export class SubjectsStream extends MailTableStream<typeof subjectsTable> {
  readonly name = 'subjects';

  constructor() {
    super(
      subjectsTable,
      "One record per distinct subject text in the local Mail index; the captured index schema stores each text once. Primary key id. messages.subject refers to id: join from messages to read a message's subject.",
      {
        ROWID:
          'Local subject identifier; messages.subject refers to it within this source.',
        subject:
          'Subject text Mail stores for its messages, passed through as collected.',
      },
    );
  }

  protected accepts(
    record: Record<string, unknown>,
    selection: MailSelection,
  ): boolean {
    return selection.subject(record.id);
  }
}
