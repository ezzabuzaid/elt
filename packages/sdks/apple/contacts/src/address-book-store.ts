import { join } from 'node:path';
import type { SQLOutputValue } from 'node:sqlite';

import { AppDatabase } from '@workspace/sdk-apple-app-database';

import {
  type ContactEntity,
  type ContactsView,
  type ContainerEntity,
  type GroupEntity,
  addressingGrammarView,
  alertToneView,
  calendarUriView,
  contactDateView,
  contactEntities,
  contactView,
  containerEntities,
  containerView,
  customPropertyValueView,
  customPropertyView,
  dateComponentsView,
  emailAddressView,
  groupEntities,
  groupView,
  likenessView,
  messagingAddressView,
  noteView,
  phoneNumberView,
  postalAddressView,
  recordView,
  relatedNameView,
  remoteLocationView,
  requiredColumns,
  requiredEntities,
  socialProfileView,
  urlAddressView,
} from './contacts-tables.ts';
import {
  type ContactsValue,
  type ContactsValues,
  type StoredData,
  attributeValue,
  storedData,
} from './contacts-values.ts';
import { ContactsSchemaError, ContactsUnavailableError } from './errors.ts';

export const storeFile = 'AddressBook-v22.abcddb';

// Core Data stores NSDate as seconds since 2001-01-01 UTC; SQLite converts
// it, so a time keeps SQLite's rounding to the millisecond.
const appleEpoch = 978307200;
const instant = (column: string) =>
  `strftime('%Y-%m-%dT%H:%M:%fZ', ${column} + ${appleEpoch}, 'unixepoch')`;
const datePart = (column: string, format: string) =>
  `CAST(strftime('${format}', ${column} + ${appleEpoch}, 'unixepoch') AS INTEGER)`;

// A view's attributes as a SELECT list under its alias: a record reference
// resolves to that record's ZUNIQUEID, and a calendar date splits into its
// Gregorian parts, the year NULL for 1604.
const select = ({ attributes }: ContactsView, alias: string): string =>
  Object.entries(attributes)
    .flatMap(([name, { column, kind }]) => {
      const value = `${alias}.${column}`;
      if (kind === 'time') return [`${instant(value)} AS "${name}"`];
      if (kind === 'record')
        return [
          `(SELECT o.ZUNIQUEID FROM ZABCDRECORD o WHERE o.Z_PK = ${value}) AS "${name}"`,
        ];
      if (kind === 'calendarDate')
        return [
          `CASE WHEN ${datePart(value, '%Y')} = 1604 THEN NULL ELSE ${datePart(value, '%Y')} END AS "${name}@year"`,
          `${datePart(value, '%m')} AS "${name}@month"`,
          `${datePart(value, '%d')} AS "${name}@day"`,
        ];
      return [`${value} AS "${name}"`];
    })
    .join(', ');

const part = (stored: SQLOutputValue | undefined) =>
  typeof stored === 'number' ? stored : null;

const text = (stored: SQLOutputValue | undefined) =>
  typeof stored === 'string' ? stored : null;

const values = (
  { attributes }: ContactsView,
  row: Record<string, SQLOutputValue>,
): ContactsValues =>
  Object.fromEntries(
    Object.entries(attributes).map(
      ([name, { kind }]): [string, ContactsValue] => [
        name,
        kind === 'calendarDate'
          ? {
              year: part(row[`${name}@year`]),
              month: part(row[`${name}@month`]),
              day: part(row[`${name}@day`]),
            }
          : attributeValue(kind, row[name]),
      ],
    ),
  );

// Entities a query keeps, joined so a renamed entity matches no row.
const entityJoin = (alias: string, entities: readonly string[]) =>
  `JOIN Z_PRIMARYKEY ${alias}_entity ON ${alias}_entity.Z_ENT = ${alias}.Z_ENT AND ${alias}_entity.Z_NAME IN (${entities.map((name) => `'${name}'`).join(', ')})`;

const entityOf = <Entity extends string>(
  entities: readonly Entity[],
  stored: SQLOutputValue | undefined,
): Entity | null => entities.find((entity) => entity === stored) ?? null;

// A contact, group or container: its identifier, Core Data entity, and its
// own and ABCDRecord attributes.
export type RecordRow<Entity> = {
  readonly id: string | null;
  readonly entity: Entity | null;
  readonly values: ContactsValues;
};

// A record that belongs to a contact and has no identifier of its own.
export type ContactPartRow = {
  readonly contactId: string | null;
  readonly values: ContactsValues;
};

// A value record with its own identifier: a labeled value, an alert tone, a
// custom property value or a remote location.
export type ValueRow = {
  readonly id: string | null;
  readonly values: ContactsValues;
};

export type MessagingAddressRow = ValueRow & {
  // ZABCDSERVICE.ZSERVICENAME of the address's service, such as SkypeInstant.
  readonly service: string | null;
};

export type GroupMemberRow = {
  readonly groupId: string | null;
  readonly contactId: string | null;
};

export type GroupSubgroupRow = {
  readonly parentGroupId: string | null;
  readonly childGroupId: string | null;
};

// A vCard line Contacts kept without interpreting it; the store keeps the
// line as bytes.
export type UnknownPropertyRow = {
  readonly recordId: string | null;
  readonly propertyName: ContactsValue;
  readonly originalLine: ContactsValue;
};

// Which of a member's addresses a distribution list (group) uses for it.
export type DistributionListConfigRow = {
  readonly groupId: string | null;
  readonly contactId: string | null;
  readonly propertyName: ContactsValue;
  readonly emailId: string | null;
  readonly phoneId: string | null;
  readonly addressId: string | null;
};

// A contact's photo and thumbnail, decoded only when asked.
export type ContactImagesRow = {
  readonly contactId: string | null;
  image(): StoredData | null;
  thumbnail(): StoredData | null;
};

// One account's store, read-only and pinned to one moment by a read
// transaction so a contact and its phones, groups and images agree.
export class AddressBookStore implements Disposable {
  // The Sources directory name, or null for the On My Mac store.
  readonly source: string | null;
  readonly directory: string;
  readonly path: string;
  readonly #database: AppDatabase;

  constructor(source: string | null, directory: string) {
    this.source = source;
    this.directory = directory;
    this.path = join(directory, storeFile);
    this.#database = new AppDatabase(this.path, ContactsUnavailableError);
  }

  // Refuses a store without a column or entity a reader needs, and closes
  // it: a renamed entity would match no rows, and an account read as empty
  // loses its contacts from every target.
  requireLayout(): void {
    this.#database.requireColumns(requiredColumns, ContactsSchemaError);
    const entities = new Set(
      this.#database
        .all('SELECT Z_NAME FROM Z_PRIMARYKEY')
        .map((entity) => entity.Z_NAME),
    );
    const missing = requiredEntities
      .filter((entity) => !entities.has(entity))
      .map((entity) => `entity ${entity}`);
    if (missing.length === 0) return;
    this[Symbol.dispose]();
    throw new ContactsSchemaError(this.path, missing);
  }

  containers(): RecordRow<ContainerEntity>[] {
    return this.#records('r', containerView, containerEntities);
  }

  groups(): RecordRow<GroupEntity>[] {
    return this.#records('g', groupView, groupEntities);
  }

  contacts(): RecordRow<ContactEntity>[] {
    return this.#records('c', contactView, contactEntities);
  }

  groupMembers(): GroupMemberRow[] {
    return this.#database
      .all(
        'SELECT g.ZUNIQUEID AS "@groupId", c.ZUNIQUEID AS "@contactId" FROM Z_22PARENTGROUPS j JOIN ZABCDRECORD g ON g.Z_PK = j.Z_19PARENTGROUPS1 JOIN ZABCDRECORD c ON c.Z_PK = j.Z_22CONTACTS',
      )
      .map((row) => ({
        groupId: text(row['@groupId']),
        contactId: text(row['@contactId']),
      }));
  }

  groupSubgroups(): GroupSubgroupRow[] {
    return this.#database
      .all(
        'SELECT p.ZUNIQUEID AS "@parentGroupId", g.ZUNIQUEID AS "@childGroupId" FROM Z_18PARENTGROUPS j JOIN ZABCDRECORD p ON p.Z_PK = j.Z_19PARENTGROUPS JOIN ZABCDRECORD g ON g.Z_PK = j.Z_18CHILDGROUPS',
      )
      .map((row) => ({
        parentGroupId: text(row['@parentGroupId']),
        childGroupId: text(row['@childGroupId']),
      }));
  }

  notes(): ContactPartRow[] {
    return this.#contactParts('n', noteView);
  }

  alternateBirthdays(): ContactPartRow[] {
    return this.#contactParts('d', dateComponentsView);
  }

  phoneNumbers(): ValueRow[] {
    return this.#valueRows('p', phoneNumberView);
  }

  emailAddresses(): ValueRow[] {
    return this.#valueRows('e', emailAddressView);
  }

  postalAddresses(): ValueRow[] {
    return this.#valueRows('a', postalAddressView);
  }

  urlAddresses(): ValueRow[] {
    return this.#valueRows('u', urlAddressView);
  }

  socialProfiles(): ValueRow[] {
    return this.#valueRows('s', socialProfileView);
  }

  messagingAddresses(): MessagingAddressRow[] {
    return this.#database
      .all(
        `SELECT m.ZUNIQUEID AS "@id", ${select(messagingAddressView, 'm')}, (SELECT s.ZSERVICENAME FROM ZABCDSERVICE s WHERE s.Z_PK = m.ZSERVICE) AS "@service" FROM ZABCDMESSAGINGADDRESS m`,
      )
      .map((row) => ({
        id: text(row['@id']),
        values: values(messagingAddressView, row),
        service: text(row['@service']),
      }));
  }

  relatedNames(): ValueRow[] {
    return this.#valueRows('n', relatedNameView);
  }

  contactDates(): ValueRow[] {
    return this.#valueRows('d', contactDateView);
  }

  calendarUris(): ValueRow[] {
    return this.#valueRows('u', calendarUriView);
  }

  addressingGrammars(): ValueRow[] {
    return this.#valueRows('g', addressingGrammarView);
  }

  likenesses(): ValueRow[] {
    return this.#valueRows('l', likenessView);
  }

  alertTones(): ValueRow[] {
    return this.#valueRows('t', alertToneView);
  }

  // Each value with its property's definition, NULL when it has none.
  customPropertyValues(): ValueRow[] {
    return this.#database
      .all(
        `SELECT v.ZUNIQUEID AS "@id", ${select(customPropertyView, 'p')}, ${select(customPropertyValueView, 'v')} FROM ZABCDCUSTOMPROPERTYVALUE v LEFT JOIN ZABCDCUSTOMPROPERTY p ON p.Z_PK = v.ZCUSTOMPROPERTY`,
      )
      .map((row) => ({
        id: text(row['@id']),
        values: {
          ...values(customPropertyView, row),
          ...values(customPropertyValueView, row),
        },
      }));
  }

  remoteLocations(): ValueRow[] {
    return this.#valueRows('l', remoteLocationView);
  }

  // The native rows have no identifier, and the same line stored twice on
  // one record is one fact.
  unknownProperties(): UnknownPropertyRow[] {
    return this.#database
      .all(
        'SELECT DISTINCT r.ZUNIQUEID AS "@recordId", u.ZPROPERTYNAME AS "@propertyName", u.ZORIGINALLINE AS "@originalLine" FROM ZABCDUNKNOWNPROPERTY u JOIN ZABCDRECORD r ON r.Z_PK = u.ZOWNER',
      )
      .map((row) => ({
        recordId: text(row['@recordId']),
        propertyName: attributeValue('text', row['@propertyName']),
        originalLine: attributeValue('text', row['@originalLine']),
      }));
  }

  distributionListConfigs(): DistributionListConfigRow[] {
    return this.#database
      .all(
        'SELECT g.ZUNIQUEID AS "@groupId", c.ZUNIQUEID AS "@contactId", d.ZPROPERTYNAME AS "@propertyName", (SELECT x.ZUNIQUEID FROM ZABCDEMAILADDRESS x WHERE x.Z_PK = d.ZEMAIL) AS "@emailId", (SELECT x.ZUNIQUEID FROM ZABCDPHONENUMBER x WHERE x.Z_PK = d.ZPHONE) AS "@phoneId", (SELECT x.ZUNIQUEID FROM ZABCDPOSTALADDRESS x WHERE x.Z_PK = d.ZADDRESS) AS "@addressId" FROM ZABCDDISTRIBUTIONLISTCONFIG d JOIN ZABCDRECORD g ON g.Z_PK = d.ZGROUP JOIN ZABCDRECORD c ON c.Z_PK = d.ZCONTACT',
      )
      .map((row) => ({
        groupId: text(row['@groupId']),
        contactId: text(row['@contactId']),
        propertyName: attributeValue('text', row['@propertyName']),
        emailId: text(row['@emailId']),
        phoneId: text(row['@phoneId']),
        addressId: text(row['@addressId']),
      }));
  }

  images(): ContactImagesRow[] {
    return this.#database
      .all(
        `SELECT c.ZUNIQUEID AS "@contactId", c.ZIMAGEDATA AS "@image", c.ZTHUMBNAILIMAGEDATA AS "@thumbnail" FROM ZABCDRECORD c ${entityJoin('c', contactEntities)} WHERE c.ZIMAGEDATA IS NOT NULL OR c.ZTHUMBNAILIMAGEDATA IS NOT NULL`,
      )
      .map((row) => {
        const decode = (stored: SQLOutputValue | undefined) =>
          stored instanceof Uint8Array
            ? storedData(this.path, this.directory, stored)
            : null;
        return {
          contactId: text(row['@contactId']),
          image: () => decode(row['@image']),
          thumbnail: () => decode(row['@thumbnail']),
        };
      });
  }

  [Symbol.dispose](): void {
    this.#database[Symbol.dispose]();
  }

  #records<Entity extends string>(
    alias: string,
    view: ContactsView,
    entities: readonly Entity[],
  ): RecordRow<Entity>[] {
    return this.#database
      .all(
        `SELECT ${alias}.ZUNIQUEID AS "@id", ${alias}_entity.Z_NAME AS "@entity", ${select(view, alias)}, ${select(recordView, alias)} FROM ZABCDRECORD ${alias} ${entityJoin(alias, entities)}`,
      )
      .map((row) => ({
        id: text(row['@id']),
        entity: entityOf(entities, row['@entity']),
        values: { ...values(view, row), ...values(recordView, row) },
      }));
  }

  #contactParts(alias: string, view: ContactsView): ContactPartRow[] {
    return this.#database
      .all(
        `SELECT c.ZUNIQUEID AS "@contactId", ${select(view, alias)} FROM ${view.table} ${alias} JOIN ZABCDRECORD c ON c.Z_PK = ${alias}.ZCONTACT`,
      )
      .map((row) => ({
        contactId: text(row['@contactId']),
        values: values(view, row),
      }));
  }

  #valueRows(alias: string, view: ContactsView): ValueRow[] {
    return this.#database
      .all(
        `SELECT ${alias}.ZUNIQUEID AS "@id", ${select(view, alias)} FROM ${view.table} ${alias}`,
      )
      .map((row) => ({ id: text(row['@id']), values: values(view, row) }));
  }
}
