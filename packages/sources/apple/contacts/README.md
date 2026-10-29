# @workspace/source-apple-contacts

An ELT source for the Contacts app. It reads the Core Data stores of Contacts in `~/Library/Application Support/AddressBook` on this Mac, in read-only mode through `@workspace/sdk-apple-contacts`. There is one store for On My Mac, `AddressBook-v22.abcddb` at the root of the folder, and one store for each account, such as iCloud or Google, in `Sources/<id>/AddressBook-v22.abcddb`. The source does not use the network or Contacts.framework, and Contacts does not have to be open.

```ts
import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';
import { AppleContactsSource } from '@workspace/source-apple-contacts/apple-contacts-source';

const source = new AppleContactsSource();
const destination = new SQLiteDestination({ path: './contacts.sqlite' });

await new Pipeline({
  history: new SQLiteSyncHistory(),
  connections: [
    new Connection({
      name: 'apple-contacts',
      source,
      destination,
      checkpoints: new SQLiteCheckpointStore({
        path: './contacts-state.sqlite',
      }),
      steps: [source.contacts, source.phoneNumbers, source.emailAddresses].map(
        (stream) =>
          new Copy(stream, destination.table(stream.name), {
            id: stream.name,
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          }),
      ),
    }),
  ],
}).run();
```

To read only some accounts, give container IDs as `collectionIds` in the second argument: `new AppleContactsSource(undefined, { collectionIds })`.

A Context Compiler import loads every stream incrementally into its `data.sqlite`. It stores each photo in its `files` folder and refers to it by `attachmentRef`.

## Access

macOS guards the AddressBook folder with the **Contacts** privacy service. Full Disk Access also gives access to it. Either grant works. macOS checks the grant of the responsible process: the app that runs the pipeline, for example the terminal. Contacts asks for access one time for that app. If you dismiss the prompt, macOS records a denial and does not show the prompt again. Then enable the app in **System Settings → Privacy & Security → Contacts**, or give it [Full Disk Access](../messages/README.md#full-disk-access).

The source does not use Contacts.framework. That framework needs the Contacts grant itself, and it gives less than the stores hold ([ADR 0001](./docs/adr/0001-contacts-reads-its-core-data-stores-not-contacts-framework.md)).

Each error below names what is missing, and each comes before a copy starts:

- A store or the `Sources` folder that the source cannot open (missing, or no permission) fails the run with `ContactsUnavailableError`.
- A store without a column that the source reads fails with `MissingColumnsError`.
- A store without a Core Data entity that the source reads fails with `ContactsSchemaError`.

## Streams

Each stored attribute of the Core Data model (`ABAddressBook`, version `24A2` on macOS 26) loads, with the name that the model gives it (`ZJOBTITLE` becomes `jobTitle`). A relationship loads as the `uniqueId` of the related record. For contacts and groups, this is the Contacts.framework identifier (`…:ABPerson`, `…:ABGroup`). Property list data loads as JSON, and other data as base64. Dates are UTC timestamps. Labels load as they are stored: the constants of Apple look like `_$!<Mobile>!$_`, and custom labels and labels that AppleScript wrote are plain text.

| Stream                                                                                                                                                                                          | Key                                        | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `containers`                                                                                                                                                                                    | `id`                                       | One for each store: `source` (the name of the `Sources` folder, null for On My Mac), `type`, `isAll`, `remoteLocation`, `lastSyncDate`, `meContactId` (the "my card" of the account), and the record fields that all entities have.                                                                                                                                                                                                                                                                          |
| `groups`                                                                                                                                                                                        | `id`                                       | `kind` (`group`, `subscribedGroup`, `smartGroup`), `name`, `containerId`, and the archived query of a smart group as JSON.                                                                                                                                                                                                                                                                                                                                                                                   |
| `groupMembers`                                                                                                                                                                                  | `groupId`, `contactId`                     | The contacts of each group.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `groupSubgroups`                                                                                                                                                                                | `parentGroupId`, `childGroupId`            | The groups in a group.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `contacts`                                                                                                                                                                                      | `id`                                       | `kind` (`contact`, `subscribedContact`), `containerId`, names and phonetic names, organization, department, job title, `birthdayYear`, `birthdayMonth` and `birthdayDay`, `linkId` (contacts that Contacts shows as one), image metadata, `meOfContainerId`, creation and modification times, and sync fields.                                                                                                                                                                                               |
| `notes`                                                                                                                                                                                         | `contactId`                                | The `text` and `richTextData` of the note.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `alternateBirthdays`                                                                                                                                                                            | `contactId`                                | The non-Gregorian birthday: `calendarIdentifier` (for example `chinese`), `era`, `year`, `month`, `day`, `isLeapMonth`.                                                                                                                                                                                                                                                                                                                                                                                      |
| `phoneNumbers`, `emailAddresses`, `postalAddresses`, `urlAddresses`, `socialProfiles`, `messagingAddresses`, `relatedNames`, `contactDates`, `calendarUris`, `addressingGrammars`, `likenesses` | `id`                                       | Labeled values: `contactId`, `label`, `isPrimary`, `isPrivate`, `orderingIndex`, and the fields of each kind. `messagingAddresses.service` is the name of the service (`SkypeInstant`, `JabberInstant`). `contactDates` has `year`, `month` and `day`. `phoneNumbers.e164` is `fullNumber` in E.164 form, read in `countryCode` or else in the region of the Mac (`AppleLocale` in the global preferences). It is NULL for a short code, and for a number without a country code when the Mac has no region. |
| `alertTones`                                                                                                                                                                                    | `id`                                       | The ringtone or text tone of a contact.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `customPropertyValues`                                                                                                                                                                          | `id`                                       | The value of a custom property on a record, with the `propertyName`, `recordType` and `valueType` of the property.                                                                                                                                                                                                                                                                                                                                                                                           |
| `remoteLocations`                                                                                                                                                                               | `id`                                       | The URLs of a record.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `unknownProperties`                                                                                                                                                                             | `recordId`, `propertyName`, `originalLine` | The vCard lines that Contacts kept but did not understand. The line (base64) is part of the key, so two identical lines load one time.                                                                                                                                                                                                                                                                                                                                                                       |
| `distributionListConfigs`                                                                                                                                                                       | `groupId`, `contactId`, `propertyName`     | The email, phone or address that a group uses for a member.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `images`                                                                                                                                                                                        | `contactId`, `kind`                        | The `image` and `thumbnail` of a contact: `storage` (`inline` or `external`), `externalId`, `byteLength`, `sha256`. This stream can give the file.                                                                                                                                                                                                                                                                                                                                                           |

The source does not read:

- the `Z_` columns of Core Data, and transient attributes;
- the values that Contacts keeps only to sort or search: creation and modification years and yearless offsets, `sortingFirstName`, `sortingLastName`, `nameNormalized`, `addressNormalized`, `lastFourDigits` and `ABCDContactIndex`;
- the sync bookkeeping: `ABCDInfo`, `ABCDDeletedRecordLog`, `CNCDChangeHistoryClient`, `CNCDProviderMetadata`, `CNCDUnifiedContactInfo` and the persistent history.

## How the source reads the stores

- **Consistency:** the [read context](../../../elt/README.md) opens each store in its own read transaction. Thus a contact agrees with its phones, groups and photos. Each store commits on its own, so two accounts can show different times. No relationship goes from one store to another.
- **Identity:** a `uniqueId` is a UUID, and it is unique in all stores. A `Z_PK` is local to a store, and the source does not export it. Contacts.framework identifies the container of an account as `<source>:ABAccount`, not by the `id` of the container row.
- **Dates:** Contacts keeps birthdays and dates as noon UTC of the day. If the year is unknown, it keeps the year 1604. These dates load as `year` (null without a year), `month` and `day`.
- **Incremental:** all 24 streams are [snapshot streams](../../../elt/README.md). Labeled values have no modification date, and deleted records leave no row. The Core Data persistent history belongs to contactsd, which removes old entries. It is not a cursor that the source controls. Thus each run reads all rows.
- **Photos:** Core Data keeps a photo inline (`0x01` and the bytes) or in its own file (`0x02` and a UUID) in `.AddressBook-v22_SUPPORT/_EXTERNAL_DATA`. The source stages an inline photo in a temporary file, and removes the file when the record is loaded. It reads an external file where it is. `sha256` makes a replaced photo a changed record. Other encodings fail the read. For iCloud contacts, the Mac keeps only the thumbnail. The full photo stays in iCloud (`imageReference`), and Contacts.framework also gives no image data for these contacts.
- **Account names:** the stores do not name their accounts. Contacts.framework gets "iCloud" or "Google" from the Accounts framework, and this source does not read it. `containers.name` is null.
- **Failures:** a store that the source cannot open stops the run. The source does not read it as empty, because that deletes the rows of its account from each target ([ADR 0002](./docs/adr/0002-a-store-that-cannot-be-read-stops-the-run.md)).
- **Watching:** contactsd writes through WALs that it keeps open. Thus `observe()` reads `PRAGMA data_version` of each store, and the list of the `Sources` folder, each second. A commit, or an added or removed account, wakes each selected stream.

## Limitations

- Every stream is a snapshot stream. Labeled values have no modification date, and deleted records leave no row. Thus each run reads every row. A record that is no longer in its store is deleted from the destination.
- The stores do not name their accounts. `containers.name` is null.
- For iCloud contacts, the Mac keeps only the thumbnail. The full photo stays in iCloud.
- Each store is read in its own transaction. Thus two accounts can show different times.
- Smart and subscribed groups, subscribed contacts, calendar URIs, likenesses, alert tones, custom property values, remote locations, unknown vCard lines and distribution list choices are not verified with real data.

## Live checks

The live check ran on **2026-09-25** (macOS 26.6.2, Node.js 26.8.1) on three stores: On My Mac with 1 contact, iCloud with 3 and Google with 410. The probes read the schema, counts and masked value shapes. The probes read field values only on synthetic probe contacts. Contacts.app scripting and Contacts.framework made these contacts, and the probes deleted them after the check. The test fixture uses the captured table definitions with synthetic rows.

- **Schema:** the model came from `ContactsPersistence.framework`. It shows which entity owns each overloaded `ZABCDRECORD` column (`ZCONTAINER` for groups, `ZCONTAINER1` for contacts, `ZNAME1` for the container name). It also shows which data can use external storage (`imageData`, `thumbnailImageData`).
- **Framework agreement:** for all 414 contacts, a non-unified Contacts.framework fetch gives the same values: identifiers, the counts for each contact of phones (470), emails (27), postal addresses (53), URLs (4), social profiles (8) and dates (1), exact thumbnail byte lengths and birthday parts.
- **Create, edit, delete:** probe contacts with each scriptable field loaded with the values written. These include a birthday and a date without a year, a Chinese-calendar birthday, custom and constant labels, Jabber and Skype addresses, a note, group membership, nested groups, and inline (37,107 bytes) and external (159,443 bytes) thumbnails. A changed job title and a removed phone wrote that contact and one deletion. The deletion of the probes removed their contacts and all child rows.
- **Photos:** the verified address book had 29: 26 thumbnails and 3 full photos, and 4 of them in external storage. A 985 KB photo saved through Contacts.framework on an iCloud contact kept only its thumbnail on the Mac.
- **Runs:** the first run takes 32 s, and Vision text recognition on the photos uses almost all of that time. A second run takes 0.13 s and writes nothing. iCloud and Google syncs write new modification times on groups and containers, and these load as real changes. Runs after the syncs ended wrote nothing.
- **Watching:** a live watch loaded a contact 0.65 s after Contacts.framework saved it, and its deletion 0.55 s after that.
- **Unverified:** the address book has no smart or subscribed groups, subscribed contacts, calendar URIs, likenesses, alert tones, custom property values, remote locations, unrecognized vCard lines or distribution list choices. Only the synthetic fixture covers these streams. Contacts.framework cannot make them: a synthetic vCard with `CALURI` and an `X-` line, saved through it, kept neither. The vCard import of the deprecated AddressBook framework saved nothing. Smart groups and distribution lists need the Contacts.app interface, and unrecognized lines need a vCard import that a person confirms in Contacts.app. Nobody did these manual steps. The deprecated AddressBook framework stopped (`SIGABRT`) when it wrote a custom property value. It cannot remove the property definition that it made, so that definition stays in the iCloud store without values.

## Decisions

- [ADR 0001](./docs/adr/0001-contacts-reads-its-core-data-stores-not-contacts-framework.md): Contacts reads its Core Data stores, not Contacts.framework.
- [ADR 0002](./docs/adr/0002-a-store-that-cannot-be-read-stops-the-run.md): a store that cannot be read stops the run.
