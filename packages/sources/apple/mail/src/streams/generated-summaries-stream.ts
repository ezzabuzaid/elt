import { generatedSummariesTable } from '@workspace/sdk-apple-mail';

import { undocumented } from '../mail-fields.ts';
import type { MailSelection } from '../mail-selection.ts';
import { MailTableStream } from '../mail-table-stream.ts';

export class GeneratedSummariesStream extends MailTableStream<
  typeof generatedSummariesTable
> {
  readonly name = 'generatedSummaries';

  constructor() {
    super(
      generatedSummariesTable,
      'One record per generated summary row in the local Mail index. Primary key id. messageGlobalData.generatedSummary refers to id. The summary is a binary payload exported as Base64 without decoding.',
      {
        ROWID:
          'Local generated summary identifier; messageGlobalData.generatedSummary refers to it within this source.',
        summary: `${undocumented} Mail's stored payload; this connector does not decode it.`,
      },
    );
  }

  protected accepts(
    record: Record<string, unknown>,
    selection: MailSelection,
  ): boolean {
    return selection.generatedSummary(record.id);
  }
}
