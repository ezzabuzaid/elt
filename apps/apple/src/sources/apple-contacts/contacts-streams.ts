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
      fields[name] = kinds[kind](`${alias}.${column}`);
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
  return {
    [year]: [
      nullableInteger,
      `CASE WHEN ${part('%Y')} = 1604 THEN NULL ELSE ${part('%Y')} END`,
    ],
    [month]: [nullableInteger, part('%m')],
    [day]: [nullableInteger, part('%d')],
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
  return {
    join: `JOIN Z_PRIMARYKEY ${alias}_entity ON ${alias}_entity.Z_ENT = ${alias}.Z_ENT AND ${alias}_entity.Z_NAME IN (${list})`,
    kind: [
      { ...text, enum: Object.values(names) },
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
  return {
    id: [id, `${alias}.ZUNIQUEID`],
    ...attributes(table, alias, {
      record: 'contactId:ZOWNER',
      text: 'label',
      boolean: 'isPrimary isPrivate',
      integer: 'orderingIndex iOSLegacyIdentifier',
    }),
    ...attributes(table, alias, list),
  };
}

type Definition = {
  readonly properties: Record<string, FieldSchema>;
  readonly primaryKey: readonly string[];
  readonly sql: string;
  readonly files?: true;
};

function definition(
  fields: Record<string, Field>,
  from: string,
  primaryKey: readonly string[],
  { distinct = false } = {},
): Definition {
  return {
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
    {
      id: [id, 'r.ZUNIQUEID'],
      // The Sources directory the store sits in, or null for On My Mac;
      // filled per store.
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
    `ZABCDRECORD r ${container.join}`,
    ['id'],
  ),
  groups: definition(
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
    `ZABCDRECORD g ${group.join}`,
    ['id'],
  ),
  groupMembers: definition(
    { groupId: [id, 'g.ZUNIQUEID'], contactId: [id, 'c.ZUNIQUEID'] },
    'Z_22PARENTGROUPS j JOIN ZABCDRECORD g ON g.Z_PK = j.Z_19PARENTGROUPS1 JOIN ZABCDRECORD c ON c.Z_PK = j.Z_22CONTACTS',
    ['groupId', 'contactId'],
  ),
  groupSubgroups: definition(
    { parentGroupId: [id, 'p.ZUNIQUEID'], childGroupId: [id, 'g.ZUNIQUEID'] },
    'Z_18PARENTGROUPS j JOIN ZABCDRECORD p ON p.Z_PK = j.Z_19PARENTGROUPS JOIN ZABCDRECORD g ON g.Z_PK = j.Z_18CHILDGROUPS',
    ['parentGroupId', 'childGroupId'],
  ),
  contacts: definition(
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
    `ZABCDRECORD c ${contact.join}`,
    ['id'],
  ),
  notes: definition(
    {
      contactId: [id, 'c.ZUNIQUEID'],
      ...attributes('ZABCDNOTE', 'n', { text: 'text', data: 'richTextData' }),
    },
    'ZABCDNOTE n JOIN ZABCDRECORD c ON c.Z_PK = n.ZCONTACT',
    ['contactId'],
  ),
  // The non-Gregorian birthday (CNContact.nonGregorianBirthday).
  alternateBirthdays: definition(
    {
      contactId: [id, 'c.ZUNIQUEID'],
      ...attributes('ZABCDDATECOMPONENTS', 'd', {
        text: 'uniqueId calendarIdentifier',
        integer: 'era year month day iOSLegacyIdentifier',
        boolean: 'isLeapMonth',
      }),
    },
    'ZABCDDATECOMPONENTS d JOIN ZABCDRECORD c ON c.Z_PK = d.ZCONTACT',
    ['contactId'],
  ),
  phoneNumbers: definition(
    labeled('ZABCDPHONENUMBER', 'p', {
      text: 'fullNumber countryCode areaCode localNumber extension',
    }),
    'ZABCDPHONENUMBER p',
    ['id'],
  ),
  emailAddresses: definition(
    labeled('ZABCDEMAILADDRESS', 'e', { text: 'address' }),
    'ZABCDEMAILADDRESS e',
    ['id'],
  ),
  postalAddresses: definition(
    labeled('ZABCDPOSTALADDRESS', 'a', {
      text: 'street subLocality city state region zipCode countryName countryCode sama',
      data: 'customValuesDictionary',
    }),
    'ZABCDPOSTALADDRESS a',
    ['id'],
  ),
  urlAddresses: definition(
    labeled('ZABCDURLADDRESS', 'u', { text: 'url' }),
    'ZABCDURLADDRESS u',
    ['id'],
  ),
  socialProfiles: definition(
    labeled('ZABCDSOCIALPROFILE', 's', {
      text: 'serviceName username userIdentifier urlString displayname bundleIdentifiersString teamIdentifier',
      data: 'customValuesData',
    }),
    'ZABCDSOCIALPROFILE s',
    ['id'],
  ),
  // Instant message addresses; service is ABCDService's name, such as SkypeInstant.
  messagingAddresses: definition(
    {
      ...labeled('ZABCDMESSAGINGADDRESS', 'm', {
        text: 'address userIdentifier bundleIdentifiersString teamIdentifier',
      }),
      service: [
        nullableText,
        '(SELECT s.ZSERVICENAME FROM ZABCDSERVICE s WHERE s.Z_PK = m.ZSERVICE)',
      ],
    },
    'ZABCDMESSAGINGADDRESS m',
    ['id'],
  ),
  relatedNames: definition(
    labeled('ZABCDRELATEDNAME', 'n', { text: 'name' }),
    'ZABCDRELATEDNAME n',
    ['id'],
  ),
  contactDates: definition(
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
    labeled('ZABCDCALENDARURI', 'u', { text: 'url' }),
    'ZABCDCALENDARURI u',
    ['id'],
  ),
  addressingGrammars: definition(
    labeled('ZABCDADDRESSINGGRAMMAR', 'g', { text: 'addressingGrammar' }),
    'ZABCDADDRESSINGGRAMMAR g',
    ['id'],
  ),
  likenesses: definition(
    labeled('ZABCDLIKENESS', 'l', {
      integer: 'kind',
      text: 'version',
      data: 'data',
    }),
    'ZABCDLIKENESS l',
    ['id'],
  ),
  alertTones: definition(
    {
      id: [id, 't.ZUNIQUEID'],
      ...attributes('ZABCDALERTTONE', 't', {
        record: 'contactId:ZOWNER',
        text: 'type toneData',
        integer: 'iOSLegacyIdentifier',
      }),
    },
    'ZABCDALERTTONE t',
    ['id'],
  ),
  // Values of custom properties, on any record, with their property's definition.
  customPropertyValues: definition(
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
    'ZABCDCUSTOMPROPERTYVALUE v LEFT JOIN ZABCDCUSTOMPROPERTY p ON p.Z_PK = v.ZCUSTOMPROPERTY',
    ['id'],
  ),
  remoteLocations: definition(
    {
      id: [id, 'l.ZUNIQUEID'],
      ...attributes('ZABCDREMOTELOCATION', 'l', {
        record: 'recordId:ZOWNER',
        text: 'label url',
        boolean: 'isPrimary isPrivate',
        integer: 'orderingIndex',
      }),
    },
    'ZABCDREMOTELOCATION l',
    ['id'],
  ),
  // vCard lines Contacts kept without understanding them. They have no
  // identifier, so the line itself is part of the key.
  unknownProperties: definition(
    {
      recordId: [id, 'r.ZUNIQUEID'],
      propertyName: [text, 'u.ZPROPERTYNAME'],
      originalLine: [text, 'u.ZORIGINALLINE'],
    },
    'ZABCDUNKNOWNPROPERTY u JOIN ZABCDRECORD r ON r.Z_PK = u.ZOWNER',
    ['recordId', 'propertyName', 'originalLine'],
    { distinct: true },
  ),
  // The address a distribution list (group) uses for each member.
  distributionListConfigs: definition(
    {
      groupId: [id, 'g.ZUNIQUEID'],
      contactId: [id, 'c.ZUNIQUEID'],
      propertyName: [text, 'd.ZPROPERTYNAME'],
      emailId: uniqueIdOf('ZABCDEMAILADDRESS', 'd.ZEMAIL'),
      phoneId: uniqueIdOf('ZABCDPHONENUMBER', 'd.ZPHONE'),
      addressId: uniqueIdOf('ZABCDPOSTALADDRESS', 'd.ZADDRESS'),
    },
    'ZABCDDISTRIBUTIONLISTCONFIG d JOIN ZABCDRECORD g ON g.Z_PK = d.ZGROUP JOIN ZABCDRECORD c ON c.Z_PK = d.ZCONTACT',
    ['groupId', 'contactId', 'propertyName'],
  ),
  // A contact's photo and thumbnail, each inline or in _EXTERNAL_DATA.
  images: {
    properties: {
      contactId: id,
      kind: { ...text, enum: ['image', 'thumbnail'] },
      storage: { ...text, enum: ['inline', 'external'] },
      externalId: nullableText,
      byteLength: { type: 'integer', minimum: 0 },
      sha256: text,
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
