import type { FieldSchema } from '@workspace/elt';
import type { ContactsView, ValueRow } from '@workspace/sdk-apple-contacts';
import { eventKitFields } from '@workspace/source-apple-macos/eventkit-fields';

import { AppleContactsStream } from './apple-contacts-stream.ts';
import {
  type Naming,
  attributeFields,
  attributeRecord,
  explained,
} from './contacts-fields.ts';
import type { ContactSelection } from './contacts-scan.ts';

export const labeledValue =
  "Primary key id; contactId refers to contacts.id, and a contact can have several. label is the stored, unlocalized label. isPrimary, isPrivate and orderingIndex pass through as stored; whether orderingIndex orders a contact's values densely or uniquely is not verified.";

// A labeled value's owner is the contact it belongs to.
const labeled = (naming: Naming): Naming => ({
  ...naming,
  renames: { owner: 'contactId' },
});

// A contact's labeled value (CNLabeledValue) as fields: its own identifier,
// the owning contact, a raw label such as _$!<Mobile>!$_ or a custom one, its
// order, then the table's own values.
export function labeledFields(
  view: ContactsView,
  naming: Naming = {},
): Record<string, FieldSchema> {
  return explained(
    { id: eventKitFields.id, ...attributeFields(view, labeled(naming)) },
    {
      id: `Identifier of this labeled value, AddressBook ${view.table}.ZUNIQUEID; the primary key.`,
      contactId: `Owning contact: ${view.table}.ZOWNER resolved to that record's ZUNIQUEID. Join to contacts.id within this source; a contact can have many of these values. NULL when unset or no record matches.`,
      label: `Label from AddressBook ${view.table}.ZLABEL, as stored and not localized: a built-in label is a token such as _$!<Mobile>!$_, a custom label is its own text. NULL when the store holds no value; it can also be empty text.`,
    },
  );
}

// A stream of one kind of a contact's labeled values: each belongs to its
// owning contact, so a container selection keeps the values of its contacts.
export abstract class LabeledValueStream<
  Row extends ValueRow = ValueRow,
> extends AppleContactsStream<Row> {
  readonly primaryKey = ['id'];
  protected abstract readonly view: ContactsView;
  protected readonly naming: Naming = {};

  protected accepts(row: Row, selection: ContactSelection): boolean {
    return selection.contact(row.values.owner);
  }

  protected records(row: Row): Record<string, unknown>[] {
    return [
      {
        id: row.id,
        ...attributeRecord(this.view, row.values, labeled(this.naming)),
      },
    ];
  }
}
