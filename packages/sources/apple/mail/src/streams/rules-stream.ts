import { plistJSON } from '@eltjs/codec-plist';

import {
  AppleMailStream,
  type MailEntry,
  mailSchema,
} from '../apple-mail-stream.ts';
import { described, plistProperties, text } from '../mail-fields.ts';
import type { MailScan } from '../mail-scan.ts';

export class RulesStream extends AppleMailStream {
  readonly name = 'rules';
  // A rules file is an array that enforces no identity, so a rule is its
  // place in the file (ADR 0022); RuleId is a column.
  readonly primaryKey = ['scope', 'position'];
  readonly jsonSchema = mailSchema(
    'One record per Mail rule in MailData/SyncedRules.plist (scope Synced) or MailData/UnsyncedRules.plist (scope Unsynced), in stored order. Primary key (scope, position). Conditions are ruleConditions rows, joined by (scope, rulePosition) to (scope, position). Scoped imports omit this stream.',
    described(
      {
        scope: text,
        position: { type: 'integer' },
        ruleId: text,
        properties: text,
        enabled: { type: ['boolean', 'null'] },
      },
      {
        scope:
          'Synced for a rule read from MailData/SyncedRules.plist, Unsynced for one read from MailData/UnsyncedRules.plist.',
        position:
          'Zero-based position of the rule in its file; with scope, the primary key.',
        ruleId:
          'RuleId value of the rule. The file does not keep it unique, so two rules can share it.',
        properties: `The whole rule dictionary, including its Criteria. ${plistProperties}`,
        enabled:
          'Value stored for this RuleId in MailData/RulesActiveState.plist; NULL when that file is absent or has no entry for the rule.',
      },
    ),
  );

  protected async *entries(
    scan: MailScan,
  ): AsyncGenerator<MailEntry, void, undefined> {
    for await (const rule of scan.snapshot.files.rules())
      yield {
        data: {
          scope: rule.scope,
          position: rule.position,
          ruleId: rule.ruleId,
          properties: plistJSON(rule.dictionary),
          enabled: rule.enabled,
        },
        file: null,
      };
  }

  // Rules of no proven account: a scoped import omits them rather than
  // copying unrelated settings.
  protected accepts(): boolean {
    return false;
  }
}
