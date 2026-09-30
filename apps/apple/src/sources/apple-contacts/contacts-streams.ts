import { type FieldSchema, Stream } from 'elt';
import type { AddressBookSchema } from '../../platform/macos/address-book.ts';
import {
  decodeArchive,
  isBinaryPlist,
  plistJSON,
} from '../../platform/macos/plist.ts';
import { eventKitFields } from '../eventkit-schema.ts';

const { text, id, nullableText, nullableTimestamp } = eventKitFields;
const nullableInteger = { type: ['integer', 'null'] } as const;
const nullableNumber = { type: ['number', 'null'] } as const;
const nullableBoolean = { type: ['boolean', 'null'] } as const;

// Core Data stores NSDate as seconds since 2001-01-01 UTC.
const appleEpoch = 978307200;
const instant = (column: string) =>
  `strftime('%Y-%m-%dT%H:%M:%fZ', ${column} + ${appleEpoch}, 'unixepoch')`;

const words = (list = '') => list.split(/\s+/).filter(Boolean);

type Field = readonly [FieldSchema, string];
type Kind =
  | 'text'
  | 'integer'
  | 'boolean'
  | 'number'
  | 'timestamp'
  | 'data'
  | 'record';

// Data loads as JSON when it is a property list and as base64 otherwise; a
// record reference loads as that record's uniqueId, the CNContact, CNGroup or
// CNContainer identifier.
const kinds: Record<Kind, (column: string) => Field> = {
  text: (column) => [nullableText, column],
  integer: (column) => [nullableInteger, column],
  boolean: (column) => [nullableBoolean, column],
  number: (column) => [nullableNumber, column],
  timestamp: (column) => [nullableTimestamp, instant(column)],
  data: (column) => [nullableText, column],
  record: (column) => [
    nullableText,
    `(SELECT o.ZUNIQUEID FROM ZABCDRECORD o WHERE o.Z_PK = ${column})`,
  ],
};

// How each kind's value reaches the record, as kinds and recordFrom read it.
const conversions: Record<Kind, string> = {
  text: 'as stored',
  integer: 'as stored',
  number: 'as stored',
  boolean: 'with 0 read as false and any other stored value as true',
  timestamp:
    'Core Data seconds since 2001-01-01 converted to a UTC instant with millisecond precision',
  data: 'a binary property list as JSON (keyed archives unarchived, nested bytes as Base64), other bytes as Base64',
  record: "a ZABCDRECORD reference resolved to that record's ZUNIQUEID",
};

const unverified = 'Meaning not verified: Apple does not document this store.';

// The description of a field that only passes a native column through.
function provenance(kind: Kind, table: string, column: string): string {
  const absent =
    kind === 'record'
      ? 'NULL when unset or no record matches'
      : 'NULL when the store holds no value';
  return `AddressBook ${table}.${column}, ${conversions[kind]}; ${absent}. ${unverified}`;
}

// Hand-written meanings replace provenance where the code proves more; a name
// the fields lack is a typo that would otherwise ship the wrong text.
function explained(
  fields: Record<string, Field>,
  meanings: Readonly<Record<string, string>>,
): Record<string, Field> {
  const described = { ...fields };
  for (const [name, description] of Object.entries(meanings)) {
    const field = fields[name];
    if (field === undefined)
      throw new TypeError(`Contacts has no field ${name} to describe`);
    described[name] = [{ ...field[0], description }, field[1]];
  }
  return described;
}

const required = new Map<string, Set<string>>();
const requiredEntities = new Set<string>();

function requires(table: string, columns: string): void {
  const present = required.get(table) ?? new Set<string>();
  required.set(table, present);
  for (const column of words(columns)) present.add(column);
}

// Attributes named as the Core Data model names them. Core Data stores
// attribute foo in ZFOO; name:ZCOLUMN picks the column when the name differs,
// as when two entities sharing ZABCDRECORD both have a `container`.
function attributes(
  table: string,
  alias: string,
  list: Partial<Record<Kind, string>>,
): Record<string, Field> {
  const fields: Record<string, Field> = {};
  for (const [kind, names] of Object.entries(list) as [Kind, string][])
    for (const token of words(names)) {
      const [name = token, column = `Z${name.toUpperCase()}`] =
        token.split(':');
      requires(table, column);
      const [schema, sql] = kinds[kind](`${alias}.${column}`);
      fields[name] = [
        { ...schema, description: provenance(kind, table, column) },
        sql,
      ];
    }
  return fields;
}

// Contacts stores a birthday or date as noon UTC of the day, in year 1604
// when the year is unknown.
function calendarDate(
  table: string,
  alias: string,
  attribute: string,
  [year, month, day]: readonly [string, string, string],
): Record<string, Field> {
  const column = `Z${attribute.toUpperCase()}`;
  requires(table, column);
  const part = (format: string) =>
    `CAST(strftime('${format}', ${alias}.${column} + ${appleEpoch}, 'unixepoch') AS INTEGER)`;
  const read = `of the date in AddressBook ${table}.${column}, Core Data seconds since 2001-01-01 read as a Gregorian UTC date`;
  return {
    [year]: [
      {
        ...nullableInteger,
        description: `Year ${read}; NULL when no date is stored or its year is 1604, the year Contacts stores for a date without a year.`,
      },
      `CASE WHEN ${part('%Y')} = 1604 THEN NULL ELSE ${part('%Y')} END`,
    ],
    [month]: [
      {
        ...nullableInteger,
        description: `Month (1-12) ${read}; NULL when no date is stored.`,
      },
      part('%m'),
    ],
    [day]: [
      {
        ...nullableInteger,
        description: `Day of the month ${read}; NULL when no date is stored.`,
      },
      part('%d'),
    ],
  };
}

// ABCDRecord, the abstract parent of contacts, groups and containers, which
// all live in ZABCDRECORD and are told apart by their Z_PRIMARYKEY entity.
const record = (alias: string) =>
  attributes('ZABCDRECORD', alias, {
    timestamp: 'creationDate modificationDate',
    integer: 'displayFlags syncStatus iOSLegacyIdentifier',
    text: 'externalCollectionPath externalFilename externalHash externalImageURI externalModificationTag externalURI externalUUID',
    data: 'externalRepresentation',
  });

function entities(
  alias: string,
  names: Readonly<Record<string, string>>,
): { readonly join: string; readonly kind: Field } {
  requires('ZABCDRECORD', 'Z_PK Z_ENT ZUNIQUEID');
  requires('Z_PRIMARYKEY', 'Z_ENT Z_NAME');
  for (const name of Object.keys(names)) requiredEntities.add(name);
  const list = Object.keys(names)
    .map((name) => `'${name}'`)
    .join(', ');
  const meanings = Object.entries(names)
    .map(([name, kind]) => `${kind} for ${name}`)
    .join(', ');
  return {
    join: `JOIN Z_PRIMARYKEY ${alias}_entity ON ${alias}_entity.Z_ENT = ${alias}.Z_ENT AND ${alias}_entity.Z_NAME IN (${list})`,
    kind: [
      {
        ...text,
        enum: Object.values(names),
        description: `Core Data entity of this record, from Z_PRIMARYKEY.Z_NAME: ${meanings}. Apple does not document how these entities differ.`,
      },
      `CASE ${alias}_entity.Z_NAME ${Object.entries(names)
        .map(([name, kind]) => `WHEN '${name}' THEN '${kind}'`)
        .join(' ')} END`,
    ],
  };
}

const contact = entities('c', {
  ABCDContact: 'contact',
  ABCDSubscribedContact: 'subscribedContact',
});
const group = entities('g', {
  ABCDGroup: 'group',
  ABCDSubscribedGroup: 'subscribedGroup',
  ABCDSmartGroup: 'smartGroup',
});
const container = entities('r', { CNCDContainer: 'container' });

// A contact's labeled value (CNLabeledValue): its own identifier, the owning
// contact, a raw label such as _$!<Mobile>!$_ or a custom one, and its order.
function labeled(
  table: string,
  alias: string,
  list: Partial<Record<Kind, string>>,
): Record<string, Field> {
  requires(table, 'ZUNIQUEID');
  return explained(
    {
      id: [id, `${alias}.ZUNIQUEID`],
      ...attributes(table, alias, {
        record: 'contactId:ZOWNER',
        text: 'label',
        boolean: 'isPrimary isPrivate',
        integer: 'orderingIndex iOSLegacyIdentifier',
      }),
      ...attributes(table, alias, list),
    },
    {
      id: `Identifier of this labeled value, AddressBook ${table}.ZUNIQUEID; the primary key.`,
      contactId: `Owning contact: ${table}.ZOWNER resolved to that record's ZUNIQUEID. Join to contacts.id within this source; a contact can have many of these values. NULL when unset or no record matches.`,
      label: `Label from AddressBook ${table}.ZLABEL, as stored and not localized: a built-in label is a token such as _$!<Mobile>!$_, a custom label is its own text. NULL when the store holds no value; it can also be empty text.`,
    },
  );
}

const labeledValue =
  "Primary key id; contactId refers to contacts.id, and a contact can have several. label is the stored, unlocalized label. isPrimary, isPrivate and orderingIndex pass through as stored; whether orderingIndex orders a contact's values densely or uniquely is not verified.";

// Every stream reads the same local stores, so every description ends with it.
const localStores =
  "Read from this Mac's Contacts stores, On My Mac and one per account under AddressBook/Sources, so it holds what has synced to this Mac rather than a complete cloud account; a configured container selection limits it further. Relationships name source streams, not destination tables, and identifiers name native records, not people merged across stores.";

type Definition = {
  readonly description: string;
  readonly properties: Record<string, FieldSchema>;
  readonly primaryKey: readonly string[];
  readonly sql: string;
  readonly files?: true;
};

function definition(
  description: string,
  fields: Record<string, Field>,
  from: string,
  primaryKey: readonly string[],
  { distinct = false } = {},
): Definition {
  return {
    description,
    properties: Object.fromEntries(
      Object.entries(fields).map(([name, [schema]]) => [name, schema]),
    ),
    primaryKey,
    sql: `SELECT ${distinct ? 'DISTINCT ' : ''}${Object.entries(fields)
      .map(([name, [, sql]]) => `${sql} AS "${name}"`)
      .join(', ')} FROM ${from}`,
  };
}

requires('Z_22PARENTGROUPS', 'Z_22CONTACTS Z_19PARENTGROUPS1');
requires('Z_18PARENTGROUPS', 'Z_18CHILDGROUPS Z_19PARENTGROUPS');
requires('ZABCDNOTE', 'ZCONTACT');
requires('ZABCDDATECOMPONENTS', 'ZCONTACT');
requires('ZABCDMESSAGINGADDRESS', 'ZSERVICE');
requires('ZABCDSERVICE', 'Z_PK ZSERVICENAME');
requires('ZABCDCUSTOMPROPERTY', 'Z_PK');
requires('ZABCDCUSTOMPROPERTYVALUE', 'ZUNIQUEID ZCUSTOMPROPERTY');
requires('ZABCDREMOTELOCATION', 'ZUNIQUEID');
requires('ZABCDUNKNOWNPROPERTY', 'ZOWNER');
requires(
  'ZABCDDISTRIBUTIONLISTCONFIG',
  'ZGROUP ZCONTACT ZEMAIL ZPHONE ZADDRESS',
);
requires('ZABCDEMAILADDRESS', 'Z_PK');
requires('ZABCDPHONENUMBER', 'Z_PK');
requires('ZABCDPOSTALADDRESS', 'Z_PK');

const uniqueIdOf = (table: string, column: string): Field => [
  nullableText,
  `(SELECT x.ZUNIQUEID FROM ${table} x WHERE x.Z_PK = ${column})`,
];

// Every stored attribute of the Core Data model (ABAddressBook, macOS 26),
// relationships as the related record's uniqueId. Left out: Core Data's own
// Z_ columns, transient attributes, values stored only to sort or search
// (creation and modification year and yearless offsets, sortingFirstName,
// nameNormalized, addressNormalized, lastFourDigits, ABCDContactIndex), and
// sync bookkeeping (ABCDInfo, ABCDDeletedRecordLog, CNCDChangeHistoryClient,
// CNCDProviderMetadata, CNCDUnifiedContactInfo, persistent history).
export const definitions = {
  containers: definition(
    'One row per Contacts container, a CNCDContainer record in a store. Primary key id. contacts.containerId, contacts.meOfContainerId and groups.containerId refer to id.',
    explained(
      {
        id: [id, 'r.ZUNIQUEID'],
        // Filled per store.
        source: [nullableText, 'NULL'],
        ...attributes('ZABCDRECORD', 'r', {
          text: 'name:ZNAME1 externalIdentifier providerIdentifier remoteLocation serialNumber',
          integer: 'type guardianFlags',
          boolean: 'isAll',
          timestamp: 'lastSyncDate',
          record: 'meContactId:ZME',
        }),
        ...record('r'),
      },
      {
        id: 'Container identifier, AddressBook ZABCDRECORD.ZUNIQUEID; the primary key.',
        source:
          'Directory name under AddressBook/Sources of the account store this container was read from; NULL for the On My Mac store at the AddressBook root.',
        meContactId:
          "AddressBook ZABCDRECORD.ZME resolved to that record's ZUNIQUEID. Join to contacts.id within this source. NULL when unset or no record matches.",
      },
    ),
    `ZABCDRECORD r ${container.join}`,
    ['id'],
  ),
  groups: definition(
    'One row per group record: an ABCDGroup, ABCDSubscribedGroup or ABCDSmartGroup, told apart by kind. Primary key id; containerId refers to containers.id. Stored members are in groupMembers, stored nesting in groupSubgroups and distribution-list configuration rows in distributionListConfigs.',
    explained(
      {
        id: [id, 'g.ZUNIQUEID'],
        kind: group.kind,
        ...attributes('ZABCDRECORD', 'g', {
          record: 'containerId:ZCONTAINER',
          text: 'name tmpRemoteLocation',
          integer: 'externalGroupBehavior',
          data: 'modifiedUniqueIdsData searchElementData',
        }),
        ...record('g'),
      },
      {
        id: 'Group identifier, AddressBook ZABCDRECORD.ZUNIQUEID; the primary key. groupMembers.groupId, groupSubgroups.parentGroupId, groupSubgroups.childGroupId and distributionListConfigs.groupId refer to it.',
        containerId:
          "Owning container: AddressBook ZABCDRECORD.ZCONTAINER resolved to that record's ZUNIQUEID. Join to containers.id within this source. NULL when unset or no record matches.",
      },
    ),
    `ZABCDRECORD g ${group.join}`,
    ['id'],
  ),
  groupMembers: definition(
    'One row per group membership stored in the AddressBook table Z_22PARENTGROUPS. Primary key (groupId, contactId). Only stored memberships appear; the connector does not evaluate smart group criteria.',
    explained(
      { groupId: [id, 'g.ZUNIQUEID'], contactId: [id, 'c.ZUNIQUEID'] },
      {
        groupId:
          'Group identifier (ZABCDRECORD.ZUNIQUEID of Z_22PARENTGROUPS.Z_19PARENTGROUPS1); refers to groups.id within this source.',
        contactId:
          'Member contact identifier (ZABCDRECORD.ZUNIQUEID of Z_22PARENTGROUPS.Z_22CONTACTS); refers to contacts.id within this source. A contact can belong to many groups.',
      },
    ),
    'Z_22PARENTGROUPS j JOIN ZABCDRECORD g ON g.Z_PK = j.Z_19PARENTGROUPS1 JOIN ZABCDRECORD c ON c.Z_PK = j.Z_22CONTACTS',
    ['groupId', 'contactId'],
  ),
  groupSubgroups: definition(
    'One row per direct parent-child link between groups stored in the AddressBook table Z_18PARENTGROUPS. Primary key (parentGroupId, childGroupId), both groups.id within this source. Deeper nesting is a chain of rows; a child can have several parents.',
    explained(
      { parentGroupId: [id, 'p.ZUNIQUEID'], childGroupId: [id, 'g.ZUNIQUEID'] },
      {
        parentGroupId:
          'Parent group identifier (ZABCDRECORD.ZUNIQUEID of Z_18PARENTGROUPS.Z_19PARENTGROUPS); refers to groups.id within this source.',
        childGroupId:
          'Child group identifier (ZABCDRECORD.ZUNIQUEID of Z_18PARENTGROUPS.Z_18CHILDGROUPS); refers to groups.id within this source.',
      },
    ),
    'Z_18PARENTGROUPS j JOIN ZABCDRECORD p ON p.Z_PK = j.Z_19PARENTGROUPS JOIN ZABCDRECORD g ON g.Z_PK = j.Z_18CHILDGROUPS',
    ['parentGroupId', 'childGroupId'],
  ),
  contacts: definition(
    'One row per contact record: an ABCDContact or ABCDSubscribedContact, told apart by kind. Primary key id; containerId refers to containers.id. Multi-valued details are separate streams keyed by their own id with contactId: phoneNumbers, emailAddresses, postalAddresses, urlAddresses, socialProfiles, messagingAddresses, relatedNames, contactDates, calendarUris, addressingGrammars and likenesses; alertTones, notes, alternateBirthdays and images also carry contactId, and groupMembers lists stored group membership. The same person in two stores is two rows; this source does not merge them.',
    explained(
      {
        id: [id, 'c.ZUNIQUEID'],
        kind: contact.kind,
        ...attributes('ZABCDRECORD', 'c', {
          record:
            'containerId:ZCONTAINER1 meOfContainerId:ZCONTAINERWHERECONTACTISME',
          text: 'title firstName middleName lastName suffix nickname maidenName phoneticFirstName phoneticMiddleName phoneticLastName phoneticOrganization phonemeData organization department jobTitle linkId identityUniqueId preferredApplePersonaIdentifier preferredLikenessSource imageType imageReference cropRect cropRectID wallpaperURI downtimeWhitelist tmpHomePage',
          integer: 'privacyFlags',
          boolean: 'preferredForLinkName preferredForLinkPhoto',
          timestamp: 'imageSyncFailedTime wallpaperSyncFailedTime',
          data: 'imageHash cropRectHash avatarRecipeData memojiMetadata sensitiveContentConfiguration wallpaper',
        }),
        ...calendarDate('ZABCDRECORD', 'c', 'birthday', [
          'birthdayYear',
          'birthdayMonth',
          'birthdayDay',
        ]),
        ...record('c'),
      },
      {
        id: 'Contact identifier, AddressBook ZABCDRECORD.ZUNIQUEID; the primary key. contactId fields in other streams of this source refer to it.',
        containerId:
          "Owning container: AddressBook ZABCDRECORD.ZCONTAINER1 resolved to that record's ZUNIQUEID. Join to containers.id within this source. NULL when unset or no record matches.",
        meOfContainerId:
          "AddressBook ZABCDRECORD.ZCONTAINERWHERECONTACTISME resolved to that record's ZUNIQUEID. Join to containers.id within this source. NULL when unset or no record matches.",
      },
    ),
    `ZABCDRECORD c ${contact.join}`,
    ['id'],
  ),
  notes: definition(
    'One row per contact that has a note record in the AddressBook table ZABCDNOTE. Primary key contactId, which refers to contacts.id; one note per contact is assumed, since the store does not enforce it.',
    explained(
      {
        contactId: [id, 'c.ZUNIQUEID'],
        ...attributes('ZABCDNOTE', 'n', { text: 'text', data: 'richTextData' }),
      },
      {
        contactId:
          'Owning contact identifier (ZABCDRECORD.ZUNIQUEID of ZABCDNOTE.ZCONTACT); the primary key. Refers to contacts.id within this source.',
      },
    ),
    'ZABCDNOTE n JOIN ZABCDRECORD c ON c.Z_PK = n.ZCONTACT',
    ['contactId'],
  ),
  // Date components owned by a contact, presumably CNContact.nonGregorianBirthday.
  alternateBirthdays: definition(
    "One row per date components record owned by a contact in the AddressBook table ZABCDDATECOMPONENTS, presumed to be the contact's non-Gregorian birthday; not verified. Primary key contactId, which refers to contacts.id; one record per contact is assumed, since the store does not enforce it. Components stay in the calendar named by calendarIdentifier and are not converted, so they do not compare with the contact's Gregorian birthdayYear, birthdayMonth and birthdayDay.",
    explained(
      {
        contactId: [id, 'c.ZUNIQUEID'],
        ...attributes('ZABCDDATECOMPONENTS', 'd', {
          text: 'uniqueId calendarIdentifier',
          integer: 'era year month day iOSLegacyIdentifier',
          boolean: 'isLeapMonth',
        }),
      },
      {
        contactId:
          'Owning contact identifier (ZABCDRECORD.ZUNIQUEID of ZABCDDATECOMPONENTS.ZCONTACT); the primary key. Refers to contacts.id within this source.',
        uniqueId:
          'Native identifier of this date-components record, AddressBook ZABCDDATECOMPONENTS.ZUNIQUEID, as stored; no other stream refers to it.',
        calendarIdentifier:
          'Calendar identifier as stored in AddressBook ZABCDDATECOMPONENTS.ZCALENDARIDENTIFIER; names the calendar that era, year, month and day are counted in.',
        era: 'Era component as stored in AddressBook ZABCDDATECOMPONENTS.ZERA, in the calendar named by calendarIdentifier; NULL when the store holds no value.',
        year: 'Year component as stored in AddressBook ZABCDDATECOMPONENTS.ZYEAR, in the calendar named by calendarIdentifier and not converted; not comparable with contacts.birthdayYear. NULL when the store holds no value.',
        month:
          'Month component as stored in AddressBook ZABCDDATECOMPONENTS.ZMONTH, in the calendar named by calendarIdentifier; NULL when the store holds no value.',
        day: 'Day component as stored in AddressBook ZABCDDATECOMPONENTS.ZDAY, in the calendar named by calendarIdentifier; NULL when the store holds no value.',
      },
    ),
    'ZABCDDATECOMPONENTS d JOIN ZABCDRECORD c ON c.Z_PK = d.ZCONTACT',
    ['contactId'],
  ),
  phoneNumbers: definition(
    `One row per phone number of a contact, a labeled value in the AddressBook table ZABCDPHONENUMBER. ${labeledValue} distributionListConfigs.phoneId refers to id.`,
    labeled('ZABCDPHONENUMBER', 'p', {
      text: 'fullNumber countryCode areaCode localNumber extension',
    }),
    'ZABCDPHONENUMBER p',
    ['id'],
  ),
  emailAddresses: definition(
    `One row per email address of a contact, a labeled value in the AddressBook table ZABCDEMAILADDRESS. ${labeledValue} distributionListConfigs.emailId refers to id.`,
    labeled('ZABCDEMAILADDRESS', 'e', { text: 'address' }),
    'ZABCDEMAILADDRESS e',
    ['id'],
  ),
  postalAddresses: definition(
    `One row per postal address of a contact, a labeled value in the AddressBook table ZABCDPOSTALADDRESS. ${labeledValue} distributionListConfigs.addressId refers to id.`,
    labeled('ZABCDPOSTALADDRESS', 'a', {
      text: 'street subLocality city state region zipCode countryName countryCode sama',
      data: 'customValuesDictionary',
    }),
    'ZABCDPOSTALADDRESS a',
    ['id'],
  ),
  urlAddresses: definition(
    `One row per URL of a contact, a labeled value in the AddressBook table ZABCDURLADDRESS. ${labeledValue}`,
    labeled('ZABCDURLADDRESS', 'u', { text: 'url' }),
    'ZABCDURLADDRESS u',
    ['id'],
  ),
  socialProfiles: definition(
    `One row per social profile of a contact, a labeled value in the AddressBook table ZABCDSOCIALPROFILE. ${labeledValue}`,
    labeled('ZABCDSOCIALPROFILE', 's', {
      text: 'serviceName username userIdentifier urlString displayname bundleIdentifiersString teamIdentifier',
      data: 'customValuesData',
    }),
    'ZABCDSOCIALPROFILE s',
    ['id'],
  ),
  // Instant message addresses; service is ABCDService's name, such as SkypeInstant.
  messagingAddresses: definition(
    `One row per instant messaging address of a contact, a labeled value in the AddressBook table ZABCDMESSAGINGADDRESS. ${labeledValue}`,
    explained(
      {
        ...labeled('ZABCDMESSAGINGADDRESS', 'm', {
          text: 'address userIdentifier bundleIdentifiersString teamIdentifier',
        }),
        service: [
          nullableText,
          '(SELECT s.ZSERVICENAME FROM ZABCDSERVICE s WHERE s.Z_PK = m.ZSERVICE)',
        ],
      },
      {
        service:
          'Service name as stored: AddressBook ZABCDSERVICE.ZSERVICENAME of the service record ZABCDMESSAGINGADDRESS.ZSERVICE references, such as SkypeInstant; NULL when unset or no service record matches.',
      },
    ),
    'ZABCDMESSAGINGADDRESS m',
    ['id'],
  ),
  relatedNames: definition(
    `One row per related name of a contact, a labeled value in the AddressBook table ZABCDRELATEDNAME. ${labeledValue}`,
    labeled('ZABCDRELATEDNAME', 'n', { text: 'name' }),
    'ZABCDRELATEDNAME n',
    ['id'],
  ),
  contactDates: definition(
    `One row per labeled date of a contact in the AddressBook table ZABCDCONTACTDATE, split into Gregorian year, month and day; year is NULL for a date stored without a year. ${labeledValue}`,
    {
      ...labeled('ZABCDCONTACTDATE', 'd', {}),
      ...calendarDate('ZABCDCONTACTDATE', 'd', 'date', [
        'year',
        'month',
        'day',
      ]),
    },
    'ZABCDCONTACTDATE d',
    ['id'],
  ),
  calendarUris: definition(
    `One row per calendar URI of a contact, a labeled value in the AddressBook table ZABCDCALENDARURI. ${labeledValue}`,
    labeled('ZABCDCALENDARURI', 'u', { text: 'url' }),
    'ZABCDCALENDARURI u',
    ['id'],
  ),
  addressingGrammars: definition(
    `One row per addressing grammar value of a contact, a labeled value in the AddressBook table ZABCDADDRESSINGGRAMMAR; the value is exported as stored and its format is not documented by Apple. ${labeledValue}`,
    labeled('ZABCDADDRESSINGGRAMMAR', 'g', { text: 'addressingGrammar' }),
    'ZABCDADDRESSINGGRAMMAR g',
    ['id'],
  ),
  likenesses: definition(
    `One row per likeness value of a contact, a labeled value in the AddressBook table ZABCDLIKENESS; kind, version and data are exported as stored and their meaning is not documented by Apple. ${labeledValue}`,
    labeled('ZABCDLIKENESS', 'l', {
      integer: 'kind',
      text: 'version',
      data: 'data',
    }),
    'ZABCDLIKENESS l',
    ['id'],
  ),
  alertTones: definition(
    'One row per alert tone record of a contact in the AddressBook table ZABCDALERTTONE. Primary key id; contactId refers to contacts.id, and a contact can have several. type and toneData are exported as stored and their values are not documented by Apple.',
    explained(
      {
        id: [id, 't.ZUNIQUEID'],
        ...attributes('ZABCDALERTTONE', 't', {
          record: 'contactId:ZOWNER',
          text: 'type toneData',
          integer: 'iOSLegacyIdentifier',
        }),
      },
      {
        id: 'Alert tone identifier, AddressBook ZABCDALERTTONE.ZUNIQUEID; the primary key.',
        contactId:
          "Owning contact: ZABCDALERTTONE.ZOWNER resolved to that record's ZUNIQUEID. Join to contacts.id within this source. NULL when unset or no record matches.",
      },
    ),
    'ZABCDALERTTONE t',
    ['id'],
  ),
  // Values of custom properties, on any record, with their property's definition.
  customPropertyValues: definition(
    'One row per custom property value in the AddressBook table ZABCDCUSTOMPROPERTYVALUE, on any record, with its property definition from ZABCDCUSTOMPROPERTY. Primary key id. recordId refers to contacts.id, groups.id or containers.id within this source, or to a record kind this source does not export. propertyName, recordType and valueType are NULL when the value has no definition record. Which of stringValue, numberValue, dateValue and dataValue holds the value is not verified against valueType.',
    explained(
      {
        id: [id, 'v.ZUNIQUEID'],
        ...attributes('ZABCDCUSTOMPROPERTY', 'p', {
          text: 'propertyName recordType',
          integer: 'valueType',
        }),
        ...attributes('ZABCDCUSTOMPROPERTYVALUE', 'v', {
          record: 'recordId:ZOWNER',
          text: 'label stringValue',
          boolean: 'isPrimary isPrivate',
          integer: 'orderingIndex iOSLegacyIdentifier dateValueYear',
          number: 'numberValue',
          timestamp: 'dateValue',
          data: 'dataValue',
        }),
      },
      {
        id: 'Custom property value identifier, AddressBook ZABCDCUSTOMPROPERTYVALUE.ZUNIQUEID; the primary key.',
        propertyName: `Property name as stored in AddressBook ZABCDCUSTOMPROPERTY.ZPROPERTYNAME, the definition ZABCDCUSTOMPROPERTYVALUE.ZCUSTOMPROPERTY references; NULL when the store holds no value or no definition record matches. ${unverified}`,
        recordType: `AddressBook ZABCDCUSTOMPROPERTY.ZRECORDTYPE of the referenced definition, as stored; NULL when the store holds no value or no definition record matches. ${unverified}`,
        valueType: `AddressBook ZABCDCUSTOMPROPERTY.ZVALUETYPE of the referenced definition, as stored; NULL when the store holds no value or no definition record matches. ${unverified}`,
        recordId:
          "Owning record: ZABCDCUSTOMPROPERTYVALUE.ZOWNER resolved to that record's ZUNIQUEID. Join to contacts.id, groups.id or containers.id within this source; it can name a record kind this source does not export. NULL when unset or no record matches.",
      },
    ),
    'ZABCDCUSTOMPROPERTYVALUE v LEFT JOIN ZABCDCUSTOMPROPERTY p ON p.Z_PK = v.ZCUSTOMPROPERTY',
    ['id'],
  ),
  remoteLocations: definition(
    'One row per remote location record in the AddressBook table ZABCDREMOTELOCATION, on any record. Primary key id. recordId refers to contacts.id, groups.id or containers.id within this source, or to a record kind this source does not export.',
    explained(
      {
        id: [id, 'l.ZUNIQUEID'],
        ...attributes('ZABCDREMOTELOCATION', 'l', {
          record: 'recordId:ZOWNER',
          text: 'label url',
          boolean: 'isPrimary isPrivate',
          integer: 'orderingIndex',
        }),
      },
      {
        id: 'Remote location identifier, AddressBook ZABCDREMOTELOCATION.ZUNIQUEID; the primary key.',
        recordId:
          "Owning record: ZABCDREMOTELOCATION.ZOWNER resolved to that record's ZUNIQUEID. Join to contacts.id, groups.id or containers.id within this source; it can name a record kind this source does not export. NULL when unset or no record matches.",
      },
    ),
    'ZABCDREMOTELOCATION l',
    ['id'],
  ),
  // vCard lines Contacts kept without understanding them. They have no
  // identifier, so the line itself is part of the key.
  unknownProperties: definition(
    'One row per distinct vCard line that Contacts kept without interpreting it, from the AddressBook table ZABCDUNKNOWNPROPERTY. The native rows have no identifier, so the primary key is (recordId, propertyName, originalLine); the same line stored twice on one record is one row. recordId refers to contacts.id, groups.id or containers.id within this source, or to a record kind this source does not export.',
    explained(
      {
        recordId: [id, 'r.ZUNIQUEID'],
        propertyName: [text, 'u.ZPROPERTYNAME'],
        originalLine: [text, 'u.ZORIGINALLINE'],
      },
      {
        recordId:
          'Owning record identifier (ZABCDRECORD.ZUNIQUEID of ZABCDUNKNOWNPROPERTY.ZOWNER). Join to contacts.id, groups.id or containers.id within this source; it can name a record kind this source does not export.',
        propertyName:
          'vCard property name as stored in AddressBook ZABCDUNKNOWNPROPERTY.ZPROPERTYNAME.',
        originalLine:
          'The original vCard line from AddressBook ZABCDUNKNOWNPROPERTY.ZORIGINALLINE, which stores bytes: exported as Base64 of those bytes, so decoding it recovers the exact line, unless those bytes form a binary property list, which loads as JSON instead. Text the store holds as text passes through unchanged.',
      },
    ),
    'ZABCDUNKNOWNPROPERTY u JOIN ZABCDRECORD r ON r.Z_PK = u.ZOWNER',
    ['recordId', 'propertyName', 'originalLine'],
    { distinct: true },
  ),
  // The address a distribution list (group) uses for each member.
  distributionListConfigs: definition(
    'One row per record in the AddressBook table ZABCDDISTRIBUTIONLISTCONFIG, which references a group, a contact and optionally an email address, phone number or postal address record; what the record means is not documented by Apple. Primary key (groupId, contactId, propertyName), assumed unique since the store does not enforce it. emailId, phoneId and addressId refer to emailAddresses.id, phoneNumbers.id and postalAddresses.id within this source.',
    explained(
      {
        groupId: [id, 'g.ZUNIQUEID'],
        contactId: [id, 'c.ZUNIQUEID'],
        propertyName: [text, 'd.ZPROPERTYNAME'],
        emailId: uniqueIdOf('ZABCDEMAILADDRESS', 'd.ZEMAIL'),
        phoneId: uniqueIdOf('ZABCDPHONENUMBER', 'd.ZPHONE'),
        addressId: uniqueIdOf('ZABCDPOSTALADDRESS', 'd.ZADDRESS'),
      },
      {
        groupId:
          'Group identifier (ZABCDRECORD.ZUNIQUEID of ZABCDDISTRIBUTIONLISTCONFIG.ZGROUP); refers to groups.id within this source.',
        contactId:
          'Member contact identifier (ZABCDRECORD.ZUNIQUEID of ZABCDDISTRIBUTIONLISTCONFIG.ZCONTACT); refers to contacts.id within this source.',
        propertyName: `Property name as stored in AddressBook ZABCDDISTRIBUTIONLISTCONFIG.ZPROPERTYNAME; part of the key. ${unverified}`,
        emailId:
          "Email address record referenced by ZABCDDISTRIBUTIONLISTCONFIG.ZEMAIL, resolved to that ZABCDEMAILADDRESS record's ZUNIQUEID. Join to emailAddresses.id within this source. NULL when unset or no record matches.",
        phoneId:
          "Phone number record referenced by ZABCDDISTRIBUTIONLISTCONFIG.ZPHONE, resolved to that ZABCDPHONENUMBER record's ZUNIQUEID. Join to phoneNumbers.id within this source. NULL when unset or no record matches.",
        addressId:
          "Postal address record referenced by ZABCDDISTRIBUTIONLISTCONFIG.ZADDRESS, resolved to that ZABCDPOSTALADDRESS record's ZUNIQUEID. Join to postalAddresses.id within this source. NULL when unset or no record matches.",
      },
    ),
    'ZABCDDISTRIBUTIONLISTCONFIG d JOIN ZABCDRECORD g ON g.Z_PK = d.ZGROUP JOIN ZABCDRECORD c ON c.Z_PK = d.ZCONTACT',
    ['groupId', 'contactId', 'propertyName'],
  ),
  // A contact's photo and thumbnail, each inline or in _EXTERNAL_DATA.
  images: {
    description:
      'One row per stored contact image, from AddressBook ZABCDRECORD.ZIMAGEDATA (kind image) and ZTHUMBNAILIMAGEDATA (kind thumbnail): at most two rows per contact. Primary key (contactId, kind); contactId refers to contacts.id. byteLength and sha256 are computed from the bytes when extracted; a stored external file that cannot be read fails the extraction instead of producing a row.',
    properties: {
      contactId: {
        ...id,
        description:
          'Contact identifier, AddressBook ZABCDRECORD.ZUNIQUEID; refers to contacts.id within this source. Part of the primary key with kind.',
      },
      kind: {
        ...text,
        enum: ['image', 'thumbnail'],
        description:
          'Which stored image this row is: image for ZABCDRECORD.ZIMAGEDATA, thumbnail for ZABCDRECORD.ZTHUMBNAILIMAGEDATA. Part of the primary key with contactId.',
      },
      storage: {
        ...text,
        enum: ['inline', 'external'],
        description:
          "Where Contacts keeps the bytes in its own store: inline inside the database column, or external in a file under the store's .AddressBook-v22_SUPPORT/_EXTERNAL_DATA directory. It describes the native source, not an exported file.",
      },
      externalId: {
        ...nullableText,
        description:
          "Contacts' storage identifier for external bytes: the file name under .AddressBook-v22_SUPPORT/_EXTERNAL_DATA recorded in the column. NULL when storage is inline. It is not an exported file.",
      },
      byteLength: {
        type: 'integer',
        minimum: 0,
        description:
          'Size in bytes of the stored image: the inline bytes after the storage marker, or the external file. Computed by this connector at extraction.',
      },
      sha256: {
        ...text,
        description:
          'Lowercase hexadecimal SHA-256 of the same bytes byteLength counts, computed by this connector at extraction.',
      },
    },
    primaryKey: ['contactId', 'kind'],
    sql: `SELECT c.ZUNIQUEID AS contactId, c.ZIMAGEDATA AS image, c.ZTHUMBNAILIMAGEDATA AS thumbnail FROM ZABCDRECORD c ${contact.join} WHERE c.ZIMAGEDATA IS NOT NULL OR c.ZTHUMBNAILIMAGEDATA IS NOT NULL`,
    files: true,
  },
} satisfies Record<string, Definition>;

requires('ZABCDRECORD', 'ZIMAGEDATA ZTHUMBNAILIMAGEDATA');
requires('ZABCDUNKNOWNPROPERTY', 'ZPROPERTYNAME ZORIGINALLINE');
requires('ZABCDDISTRIBUTIONLISTCONFIG', 'ZPROPERTYNAME');

export const requiredSchema: AddressBookSchema = {
  columns: Object.fromEntries(
    [...required].map(([table, columns]) => [table, [...columns]]),
  ),
  entities: [...requiredEntities],
};

export type StreamName = keyof typeof definitions;

export const streams = Object.fromEntries(
  Object.entries(definitions).map(([name, definition]) => [
    name,
    new Stream({
      name,
      jsonSchema: {
        type: 'object',
        description: `${definition.description} ${localStores}`,
        properties: definition.properties,
        required: Object.keys(definition.properties),
      },
      primaryKey: [...definition.primaryKey],
      supportedSyncModes: ['full_refresh', 'incremental'],
      sourceDefinedCursor: true,
      emitsDeletes: true,
      ...('files' in definition && { supportsFileTransfer: true }),
    }),
  ]),
) as Record<StreamName, Stream>;

// One SQL row as its stream's record: 0/1 flags as booleans, property lists
// as JSON and other bytes as base64.
export function recordFrom(
  name: StreamName,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [field, schema] of Object.entries(definitions[name].properties)) {
    const value = row[field] ?? null;
    record[field] =
      value === null
        ? null
        : schema.type.includes('boolean')
          ? value !== 0
          : value instanceof Uint8Array
            ? isBinaryPlist(value)
              ? plistJSON(decodeArchive(value))
              : Buffer.from(value).toString('base64')
            : value;
  }
  return record;
}
