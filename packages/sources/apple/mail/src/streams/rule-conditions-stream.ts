import { plistJSON } from '@eltjs/codec-plist';

import {
  AppleMailStream,
  type MailEntry,
  mailSchema,
} from '../apple-mail-stream.ts';
import { described, plistProperties, text } from '../mail-fields.ts';
import type { MailScan } from '../mail-scan.ts';

const integer = { type: 'integer' } as const;

export class RuleConditionsStream extends AppleMailStream {
  readonly name = 'ruleConditions';
  readonly primaryKey = ['scope', 'rulePosition', 'position'];
  readonly jsonSchema = mailSchema(
    "One record per entry of a rule's Criteria list, in stored order. Primary key (scope, rulePosition, position). Join (scope, rulePosition) to rules (scope, position) within this source. A rule without Criteria has no rows. Scoped imports omit this stream.",
    described(
      {
        scope: text,
        rulePosition: integer,
        position: integer,
        properties: text,
      },
      {
        scope:
          'Scope of the owning rule, Synced or Unsynced; joins to rules.scope together with rulePosition.',
        rulePosition:
          'Position of the owning rule in its file; join (scope, rulePosition) to rules (scope, position) within this source.',
        position:
          "Zero-based position of the condition in the rule's Criteria list.",
        properties: `The condition dictionary. ${plistProperties}`,
      },
    ),
  );

  protected async *entries(
    scan: MailScan,
  ): AsyncGenerator<MailEntry, void, undefined> {
    for await (const rule of scan.snapshot.files.rules())
      for (const [position, condition] of rule.conditions().entries())
        yield {
          data: {
            scope: rule.scope,
            rulePosition: rule.position,
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
