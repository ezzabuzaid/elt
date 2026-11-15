import type { RecordDraft } from '@eltjs/elt';
import type { Dataclass } from '@eltjs/sdk-apple-accounts';

import type { AccountsScan } from '../accounts-scan.ts';
import {
  AppleAccountsStream,
  accountsFields,
} from '../apple-accounts-stream.ts';

const { id, integer, nullableInteger } = accountsFields;

const properties = {
  id: {
    ...integer,
    description:
      'The data class row (ZDATACLASS.Z_PK); the primary key. accountDataclasses.dataclassId and the accountTypes data class id lists refer to it within this source.',
  },
  name: {
    ...id,
    description:
      'Data class name, such as com.apple.Dataclass.Mail. The store does not keep it unique, so two rows can share one.',
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
  readonly primaryKey = ['id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per kind of data the Accounts framework knows accounts can sync, such as mail, calendars or contacts. Primary key id.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: AccountsScan): Iterable<Dataclass> {
    return scan.snapshot.dataclasses();
  }

  protected records(dataclass: Dataclass): RecordDraft<typeof properties>[] {
    return [
      {
        id: dataclass.id,
        name: dataclass.name,
        enumValue: dataclass.enumValue,
      },
    ];
  }
}
