import { brandIndicatorEvidenceTable } from '@workspace/sdk-apple-mail';

import type { MailSelection } from '../mail-selection.ts';
import { MailTableStream } from '../mail-table-stream.ts';

export class BrandIndicatorEvidenceStream extends MailTableStream<
  typeof brandIndicatorEvidenceTable
> {
  readonly name = 'brandIndicatorEvidence';

  constructor() {
    super(
      brandIndicatorEvidenceTable,
      'One record per brand indicator evidence row in the local Mail index. Primary key id. brandIndicator refers to brandIndicators.id; (brandIndicator, url) is unique in the captured index schema. evidence is binary, exported as Base64 without decoding.',
      {
        ROWID: 'Local brand indicator evidence row identifier.',
        brand_indicator: 'Refers to brandIndicators.id within this source.',
      },
    );
  }

  protected accepts(
    record: Record<string, unknown>,
    selection: MailSelection,
  ): boolean {
    return selection.brand(record.brandIndicator);
  }
}
