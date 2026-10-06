import { brandIndicatorsTable } from '@workspace/sdk-apple-mail';

import { undocumented } from '../mail-fields.ts';
import type { MailSelection } from '../mail-selection.ts';
import { MailTableStream } from '../mail-table-stream.ts';

export class BrandIndicatorsStream extends MailTableStream<
  typeof brandIndicatorsTable
> {
  readonly name = 'brandIndicators';

  constructor() {
    super(
      brandIndicatorsTable,
      'One record per brand indicator row in the local Mail index. Primary key id. messages.brandIndicator and brandIndicatorEvidence.brandIndicator refer to id; url is unique in the captured index schema. indicator is binary, exported as Base64 without decoding.',
      {
        ROWID:
          'Local brand indicator identifier; messages.brandIndicator and brandIndicatorEvidence.brandIndicator refer to it within this source.',
        url: `${undocumented} Unique in the captured index schema.`,
      },
    );
  }

  protected accepts(
    record: Record<string, unknown>,
    selection: MailSelection,
  ): boolean {
    return selection.brand(record.id);
  }
}
