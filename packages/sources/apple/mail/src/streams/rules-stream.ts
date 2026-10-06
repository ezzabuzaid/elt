import {
  AppleMailStream,
  type MailEntry,
  mailSchema,
} from '../apple-mail-stream.ts';
import {
  described,
  plistJSON,
  plistProperties,
  scopedMetadata,
} from '../mail-fields.ts';
import type { MailScan } from '../mail-scan.ts';

export class RulesStream extends AppleMailStream {
  readonly name = 'rules';
  readonly primaryKey = ['scope', 'id'];
  readonly jsonSchema = mailSchema(
    'One record per Mail rule in MailData/SyncedRules.plist (scope Synced) or MailData/UnsyncedRules.plist (scope Unsynced). Primary key (scope, id). Conditions are ruleConditions rows, joined by (scope, ownerId) to (scope, id). Scoped imports omit this stream.',
    described(
      { ...scopedMetadata, enabled: { type: ['boolean', 'null'] } },
      {
        scope:
          'Synced for a rule read from MailData/SyncedRules.plist, Unsynced for one read from MailData/UnsyncedRules.plist.',
        id: 'RuleId value of the rule; with scope, the primary key.',
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
          id: rule.id,
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
