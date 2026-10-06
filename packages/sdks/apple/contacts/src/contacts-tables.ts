import type { AppDatabaseColumns } from '@workspace/sdk-apple-app-database';

const kinds = [
  'text',
  'integer',
  'boolean',
  'number',
  'time',
  'data',
  'record',
  'calendarDate',
] as const;

// How the AddressBook store keeps an attribute: text, integers, numbers and
// 0/1 flags as Core Data writes them, a time as Core Data seconds since
// 2001-01-01 UTC, data as bytes, a record as the Z_PK of another ZABCDRECORD
// row, and a calendar date as noon UTC of the day, in 1604 without a year.
export type ContactsAttributeKind = (typeof kinds)[number];

const isKind = (name: string): name is ContactsAttributeKind =>
  kinds.some((kind) => kind === name);

export type ContactsAttribute = {
  readonly column: string;
  readonly kind: ContactsAttributeKind;
};

// A Core Data entity's attributes in one table, named as the Core Data model
// names them and listed in the order readers show them, with the columns read
// only to join or identify rows.
export type ContactsView = {
  readonly table: string;
  readonly joins: readonly string[];
  readonly attributes: Readonly<Record<string, ContactsAttribute>>;
};

// Core Data stores attribute foo in ZFOO; name:ZCOLUMN gives the column when
// it differs, as when two entities sharing ZABCDRECORD both have a container.
// Kinds keep the order they are written in.
function view(
  table: string,
  joins: readonly string[],
  list: Partial<Record<ContactsAttributeKind, string>>,
): ContactsView {
  const attributes: Record<string, ContactsAttribute> = {};
  for (const [kind, names = ''] of Object.entries(list)) {
    if (!isKind(kind))
      throw new TypeError(`Contacts has no attribute kind ${kind}`);
    for (const token of names.split(/\s+/).filter(Boolean)) {
      const [name = token, column = `Z${name.toUpperCase()}`] =
        token.split(':');
      if (Object.hasOwn(attributes, name))
        throw new TypeError(`Contacts ${table} lists ${name} twice`);
      attributes[name] = { column, kind };
    }
  }
  return { table, joins, attributes };
}

// A contact's labeled value (CNLabeledValue): its owner, a raw label such as
// _$!<Mobile>!$_ or a custom one, and its order, then the table's own values.
function labeledView(
  table: string,
  joins: readonly string[],
  own: Partial<Record<ContactsAttributeKind, string>>,
): ContactsView {
  const shared = view(table, ['ZUNIQUEID', ...joins], {
    record: 'owner',
    text: 'label',
    boolean: 'isPrimary isPrivate',
    integer: 'orderingIndex iOSLegacyIdentifier',
  });
  const values = view(table, [], own);
  for (const name of Object.keys(values.attributes))
    if (Object.hasOwn(shared.attributes, name))
      throw new TypeError(`Contacts ${table} lists ${name} twice`);
  return {
    ...shared,
    attributes: { ...shared.attributes, ...values.attributes },
  };
}

// The Core Data entities ZABCDRECORD rows of each kind belong to.
export const containerEntities = ['CNCDContainer'] as const;
export const groupEntities = [
  'ABCDGroup',
  'ABCDSubscribedGroup',
  'ABCDSmartGroup',
] as const;
export const contactEntities = [
  'ABCDContact',
  'ABCDSubscribedContact',
] as const;

export type ContainerEntity = (typeof containerEntities)[number];
export type GroupEntity = (typeof groupEntities)[number];
export type ContactEntity = (typeof contactEntities)[number];

// Every stored attribute of the Core Data model (ABAddressBook, macOS 26),
// relationships as the related record's uniqueId. Left out: Core Data's own
// Z_ columns, transient attributes, values stored only to sort or search
// (creation and modification year and yearless offsets, sortingFirstName,
// nameNormalized, addressNormalized, lastFourDigits, ABCDContactIndex), and
// sync bookkeeping (ABCDInfo, ABCDDeletedRecordLog, CNCDChangeHistoryClient,
// CNCDProviderMetadata, CNCDUnifiedContactInfo, persistent history).

// ABCDRecord, the abstract parent of contacts, groups and containers, which
// all live in ZABCDRECORD and are told apart by their Z_PRIMARYKEY entity.
export const recordView = view('ZABCDRECORD', ['Z_PK', 'Z_ENT', 'ZUNIQUEID'], {
  time: 'creationDate modificationDate',
  integer: 'displayFlags syncStatus iOSLegacyIdentifier',
  text: 'externalCollectionPath externalFilename externalHash externalImageURI externalModificationTag externalURI externalUUID',
  data: 'externalRepresentation',
});

export const containerView = view('ZABCDRECORD', [], {
  text: 'name:ZNAME1 externalIdentifier providerIdentifier remoteLocation serialNumber',
  integer: 'type guardianFlags',
  boolean: 'isAll',
  time: 'lastSyncDate',
  record: 'me',
});

export const groupView = view('ZABCDRECORD', [], {
  record: 'container',
  text: 'name tmpRemoteLocation',
  integer: 'externalGroupBehavior',
  data: 'modifiedUniqueIdsData searchElementData',
});

export const contactView = view(
  'ZABCDRECORD',
  ['ZIMAGEDATA', 'ZTHUMBNAILIMAGEDATA'],
  {
    record: 'container:ZCONTAINER1 containerWhereContactIsMe',
    text: 'title firstName middleName lastName suffix nickname maidenName phoneticFirstName phoneticMiddleName phoneticLastName phoneticOrganization phonemeData organization department jobTitle linkId identityUniqueId preferredApplePersonaIdentifier preferredLikenessSource imageType imageReference cropRect cropRectID wallpaperURI downtimeWhitelist tmpHomePage',
    integer: 'privacyFlags',
    boolean: 'preferredForLinkName preferredForLinkPhoto',
    time: 'imageSyncFailedTime wallpaperSyncFailedTime',
    data: 'imageHash cropRectHash avatarRecipeData memojiMetadata sensitiveContentConfiguration wallpaper',
    calendarDate: 'birthday',
  },
);

export const noteView = view('ZABCDNOTE', ['ZCONTACT'], {
  text: 'text',
  data: 'richTextData',
});

// The non-Gregorian birthday (CNContact.nonGregorianBirthday).
export const dateComponentsView = view('ZABCDDATECOMPONENTS', ['ZCONTACT'], {
  text: 'uniqueId calendarIdentifier',
  integer: 'era year month day iOSLegacyIdentifier',
  boolean: 'isLeapMonth',
});

export const phoneNumberView = labeledView('ZABCDPHONENUMBER', ['Z_PK'], {
  text: 'fullNumber countryCode areaCode localNumber extension',
});

export const emailAddressView = labeledView('ZABCDEMAILADDRESS', ['Z_PK'], {
  text: 'address',
});

export const postalAddressView = labeledView('ZABCDPOSTALADDRESS', ['Z_PK'], {
  text: 'street subLocality city state region zipCode countryName countryCode sama',
  data: 'customValuesDictionary',
});

export const urlAddressView = labeledView('ZABCDURLADDRESS', [], {
  text: 'url',
});

export const socialProfileView = labeledView('ZABCDSOCIALPROFILE', [], {
  text: 'serviceName username userIdentifier urlString displayname bundleIdentifiersString teamIdentifier',
  data: 'customValuesData',
});

// Instant message addresses; their service is an ABCDService record.
export const messagingAddressView = labeledView(
  'ZABCDMESSAGINGADDRESS',
  ['ZSERVICE'],
  { text: 'address userIdentifier bundleIdentifiersString teamIdentifier' },
);

export const relatedNameView = labeledView('ZABCDRELATEDNAME', [], {
  text: 'name',
});

export const contactDateView = labeledView('ZABCDCONTACTDATE', [], {
  calendarDate: 'date',
});

export const calendarUriView = labeledView('ZABCDCALENDARURI', [], {
  text: 'url',
});

export const addressingGrammarView = labeledView('ZABCDADDRESSINGGRAMMAR', [], {
  text: 'addressingGrammar',
});

export const likenessView = labeledView('ZABCDLIKENESS', [], {
  integer: 'kind',
  text: 'version',
  data: 'data',
});

export const alertToneView = view('ZABCDALERTTONE', ['ZUNIQUEID'], {
  record: 'owner',
  text: 'type toneData',
  integer: 'iOSLegacyIdentifier',
});

export const customPropertyView = view('ZABCDCUSTOMPROPERTY', ['Z_PK'], {
  text: 'propertyName recordType',
  integer: 'valueType',
});

// Values of custom properties, on any record.
export const customPropertyValueView = view(
  'ZABCDCUSTOMPROPERTYVALUE',
  ['ZUNIQUEID', 'ZCUSTOMPROPERTY'],
  {
    record: 'owner',
    text: 'label stringValue',
    boolean: 'isPrimary isPrivate',
    integer: 'orderingIndex iOSLegacyIdentifier dateValueYear',
    number: 'numberValue',
    time: 'dateValue',
    data: 'dataValue',
  },
);

export const remoteLocationView = view('ZABCDREMOTELOCATION', ['ZUNIQUEID'], {
  record: 'owner',
  text: 'label url',
  boolean: 'isPrimary isPrivate',
  integer: 'orderingIndex',
});

const views: readonly ContactsView[] = [
  recordView,
  containerView,
  groupView,
  contactView,
  noteView,
  dateComponentsView,
  phoneNumberView,
  emailAddressView,
  postalAddressView,
  urlAddressView,
  socialProfileView,
  messagingAddressView,
  relatedNameView,
  contactDateView,
  calendarUriView,
  addressingGrammarView,
  likenessView,
  alertToneView,
  customPropertyView,
  customPropertyValueView,
  remoteLocationView,
];

// Tables read only to join, or for values no view lists.
const otherColumns: AppDatabaseColumns = {
  Z_PRIMARYKEY: ['Z_ENT', 'Z_NAME'],
  Z_22PARENTGROUPS: ['Z_22CONTACTS', 'Z_19PARENTGROUPS1'],
  Z_18PARENTGROUPS: ['Z_18CHILDGROUPS', 'Z_19PARENTGROUPS'],
  ZABCDSERVICE: ['Z_PK', 'ZSERVICENAME'],
  ZABCDUNKNOWNPROPERTY: ['ZOWNER', 'ZPROPERTYNAME', 'ZORIGINALLINE'],
  ZABCDDISTRIBUTIONLISTCONFIG: [
    'ZGROUP',
    'ZCONTACT',
    'ZEMAIL',
    'ZPHONE',
    'ZADDRESS',
    'ZPROPERTYNAME',
  ],
};

// Every column a reader of these views reads, by table.
export const requiredColumns: AppDatabaseColumns = (() => {
  const required = new Map<string, Set<string>>();
  const add = (table: string, columns: readonly string[]) => {
    const present = required.get(table) ?? new Set<string>();
    required.set(table, present);
    for (const column of columns) present.add(column);
  };
  for (const { table, joins, attributes } of views)
    add(table, [
      ...joins,
      ...Object.values(attributes).map(({ column }) => column),
    ]);
  for (const [table, columns] of Object.entries(otherColumns))
    add(table, columns);
  return Object.fromEntries(
    [...required].map(([table, columns]) => [table, [...columns]]),
  );
})();

export const requiredEntities: readonly string[] = [
  ...contactEntities,
  ...groupEntities,
  ...containerEntities,
];
