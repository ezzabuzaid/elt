import { summariesTable } from '@workspace/sdk-apple-mail';

import type { MailSelection } from '../mail-selection.ts';
import { MailTableStream } from '../mail-table-stream.ts';

export class SummariesStream extends MailTableStream<typeof summariesTable> {
  readonly name = 'summaries';

  constructor() {
    super(
      summariesTable,
      "One record per distinct summary text in the local Mail index; the captured index schema stores each text once. Primary key id. messages.summary refers to id: join from messages to read a message's summary.",
      {
        ROWID:
          'Local summary identifier; messages.summary refers to it within this source.',
        summary:
          'Summary text Mail already stores, passed through as collected; this connector generates no summaries.',
      },
    );
  }

  protected accepts(
    record: Record<string, unknown>,
    selection: MailSelection,
  ): boolean {
    return selection.summary(record.id);
  }
}
