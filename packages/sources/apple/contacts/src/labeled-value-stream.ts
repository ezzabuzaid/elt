import type { FieldSchema } from '@eltjs/elt';
import type {
  AddressBookStore,
  ContactsView,
  ValueRow,
} from '@eltjs/sdk-apple-contacts';
import { eventKitFields } from '@eltjs/source-apple-macos/eventkit-fields';

import { AppleContactsStream } from './apple-contacts-stream.ts';
import {
  type Naming,
  attributeFields,
  attributeRecord,
  explained,
  storeField,
} from './contacts-fields.ts';
import type { ContactSelection, ContactsScan } from './contacts-scan.ts';

export const labeledValue =
  "Primary key (store, id); contactId refers to contacts.id in the same store, and a contact can have several. label is the stored, unlocalized label. isPrimary, isPrivate and orderingIndex pass through as stored; whether orderingIndex orders a contact's values densely or uniquely is not verified.";

// A labeled value's owner is the contact it belongs to.
const labeled = (naming: Naming): Naming => ({
  ...naming,
  renames: { owner: 'contactId' },
});

// A contact's labeled value (CNLabeledValue) as fields: its store, its row,
// its native identifier, the owning contact, a raw label such as
// _$!<Mobile>!$_ or a custom one, its order, then the table's own values.
export function labeledFields(
  view: ContactsView,
  naming: Naming = {},
): Record<string, FieldSchema> {
  return explained(
    {
      store: storeField,
      id: eventKitFields.integer,
      uniqueId: eventKitFields.nullableText,
      ...attributeFields(view, labeled(naming)),
    },
    {
      id: `This labeled value's row in its store, AddressBook ${view.table}.Z_PK; with store, the primary key.`,
      uniqueId: `Native identifier of this labeled value, AddressBook ${view.table}.ZUNIQUEID, as stored; the store indexes it but does not enforce it unique.`,
      contactId: `Owning contact: ${view.table}.ZOWNER, the Z_PK of that record. Join to contacts.id in the same store; a contact can have many of these values. NULL when unset or no record matches.`,
      label: `Label from AddressBook ${view.table}.ZLABEL, as stored and not localized: a built-in label is a token such as _$!<Mobile>!$_, a custom label is its own text. NULL when the store holds no value; it can also be empty text.`,
    },
  );
}

// A stream of one kind of a contact's labeled values: each belongs to its
// owning contact, so a container selection keeps the values of its contacts.
export abstract class LabeledValueStream<
  Row extends ValueRow = ValueRow,
> extends AppleContactsStream<Row> {
  readonly primaryKey = ['store', 'id'];
  protected abstract readonly view: ContactsView;
  protected readonly naming: Naming = {};

  protected accepts(row: Row, selection: ContactSelection): boolean {
    return selection.contact(row.values.owner);
  }

  protected records(
    row: Row,
    _store: AddressBookStore,
    _scan: ContactsScan,
  ): Record<string, unknown>[] {
    return [
      {
        id: row.id,
        uniqueId: row.uniqueId,
        ...attributeRecord(this.view, row.values, labeled(this.naming)),
      },
    ];
  }
}
