import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EarlyMonthSpend } from './early-month-spend.ts';
import { KeywordText } from './keyword-text.ts';
import { MissingMidMonthCredit } from './missing-mid-month-credit.ts';
import { SpendSpike } from './spend-spike.ts';

test('each notifying automation tells the user its match in words', () => {
  assert.equal(
    new EarlyMonthSpend().message({ key: '2026-10', data: { spent: 210.5 } }),
    'You spent 210.5 JOD in the first 10 days of 2026-10.',
  );
  assert.equal(
    new SpendSpike().message({
      key: '2026-W06',
      data: { spent: 1774.731, usual: 274.264 },
    }),
    'You spent 1774.731 JOD in 2026-W06, over twice your usual 274.264 JOD a week.',
  );
  assert.equal(
    new MissingMidMonthCredit().message({
      key: '2026-10',
      data: { due: '2026-10-17' },
    }),
    'The mid-month credit of 2026-10 has not arrived. It was due by 2026-10-17.',
  );
  assert.equal(
    new KeywordText().message({
      key: 'p:0/guid',
      data: { text: 'proactive: call the bank tomorrow' },
    }),
    'proactive: call the bank tomorrow',
  );
});
