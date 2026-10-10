import type { RecordDraft } from '@workspace/elt';
import type { Pass } from '@workspace/sdk-apple-wallet';

import { AppleWalletStream, walletFields } from '../apple-wallet-stream.ts';

const { id, text } = walletFields;

const properties = {
  passId: { ...id, description: 'The pass it is in; refers to passes.id.' },
  language: {
    ...id,
    description:
      'The language, as the bundle’s <language>.lproj folder names it, such as en or pt-BR.',
  },
  key: {
    ...text,
    description:
      'The localization key, the text pass.json writes in its place: a field’s label or value, the pass’s description or logoText.',
  },
  text: {
    ...text,
    description: 'What Wallet shows for key in this language.',
  },
} as const;

export class PassLocalizationsStream extends AppleWalletStream<
  typeof properties
> {
  readonly name = 'passLocalizations';
  readonly primaryKey = ['passId', 'language', 'key'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per text a pass translates, from each <language>.lproj/pass.strings in its bundle. Wallet shows a key’s text in the device’s language; join on passId and key to read a pass in a language. Primary key passId, language, key.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected records(pass: Pass): RecordDraft<typeof properties>[] {
    return pass.strings.map((entry) => ({ passId: pass.id, ...entry }));
  }
}
