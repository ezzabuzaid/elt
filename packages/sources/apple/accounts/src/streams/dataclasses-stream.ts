import type { RecordDraft } from '@workspace/elt';
import type { Dataclass } from '@workspace/macos-accounts';

import type { AccountsScan } from '../accounts-scan.ts';
import {
  AppleAccountsStream,
  accountsFields,
} from '../apple-accounts-stream.ts';

const { id, nullableInteger } = accountsFields;

const properties = {
  name: {
    ...id,
    description:
      'Data class name, such as com.apple.Dataclass.Mail; the primary key. accountDataclasses.dataclass and the accountTypes data class lists refer to it within this source.',
  },
  enumValue: {
    ...nullableInteger,
    description:
      "The Accounts framework's number for the data class as stored; several data classes can share one. NULL when it holds none.",
  },
} as const;

export class DataclassesStream extends AppleAccountsStream<
  typeof properties,
  Dataclass
> {
  readonly name = 'dataclasses';
  readonly primaryKey = ['name'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per kind of data the Accounts framework knows accounts can sync, such as mail, calendars or contacts. Primary key name.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: AccountsScan): readonly Dataclass[] {
    return scan.dataclasses;
  }

  protected records(dataclass: Dataclass): RecordDraft<typeof properties>[] {
    return [{ name: dataclass.name, enumValue: dataclass.enumValue }];
  }
}
