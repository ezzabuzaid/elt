import {
  AppleMailStream,
  type MailEntry,
  mailSchema,
} from '../apple-mail-stream.ts';
import {
  conditionFields,
  described,
  plistJSON,
  plistProperties,
} from '../mail-fields.ts';
import type { MailScan } from '../mail-scan.ts';

export class RuleConditionsStream extends AppleMailStream {
  readonly name = 'ruleConditions';
  readonly primaryKey = ['scope', 'ownerId', 'position'];
  readonly jsonSchema = mailSchema(
    "One record per entry of a rule's Criteria list, in stored order. Primary key (scope, ownerId, position). Join (scope, ownerId) to rules (scope, id) within this source. A rule without Criteria has no rows. Scoped imports omit this stream.",
    described(conditionFields, {
      scope:
        'Scope of the owning rule, Synced or Unsynced; joins to rules.scope together with ownerId.',
      ownerId:
        'RuleId of the owning rule; join (scope, ownerId) to rules (scope, id) within this source.',
      position:
        "Zero-based position of the condition in the rule's Criteria list.",
      properties: `The condition dictionary. ${plistProperties}`,
    }),
  );

  protected async *entries(
    scan: MailScan,
  ): AsyncGenerator<MailEntry, void, undefined> {
    for await (const rule of scan.snapshot.files.rules())
      for (const [position, condition] of rule.conditions().entries())
        yield {
          data: {
            scope: rule.scope,
            ownerId: rule.id,
            position,
            properties: plistJSON(condition),
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
