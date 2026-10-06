import { richLinksTable } from '@workspace/sdk-apple-mail';

import { undocumented } from '../mail-fields.ts';
import type { MailSelection } from '../mail-selection.ts';
import { MailTableStream } from '../mail-table-stream.ts';

export class RichLinksStream extends MailTableStream<typeof richLinksTable> {
  readonly name = 'richLinks';

  constructor() {
    super(
      richLinksTable,
      'One record per rich link row in the local Mail index. Primary key id. messageRichLinks.richLink refers to id; hash is unique in the captured index schema.',
      {
        ROWID:
          'Local rich link identifier; messageRichLinks.richLink refers to it within this source.',
        hash: `${undocumented} Unique in the captured index schema.`,
      },
    );
  }

  protected accepts(
    record: Record<string, unknown>,
    selection: MailSelection,
  ): boolean {
    return selection.richLink(record.id);
  }
}
