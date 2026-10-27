# @workspace/source-apple-contacts

An ELT source for the Contacts app. It reads the Core Data stores of Contacts in `~/Library/Application Support/AddressBook` on this Mac: one store for On My Mac and one store for each account, such as iCloud or Google. It does not use the network or Contacts.framework, and Contacts does not have to be open.

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

The source has 24 streams:

- `containers`: one for each store, with the "my card" contact of the account.
- `groups`, `groupMembers`, `groupSubgroups`: groups, their contacts and the groups in them.
- `contacts`, `notes`, `alternateBirthdays`: contacts, their notes and their non-Gregorian birthdays.
- `phoneNumbers`, `emailAddresses`, `postalAddresses`, `urlAddresses`, `socialProfiles`, `messagingAddresses`, `relatedNames`, `contactDates`, `calendarUris`, `addressingGrammars`, `likenesses`: labeled values of a contact.
- `alertTones`, `customPropertyValues`, `remoteLocations`, `unknownProperties`, `distributionListConfigs`: ringtones and text tones, custom properties, URLs, vCard lines that Contacts did not understand, and the address that a group uses for a member.
- `images`: the image and thumbnail of a contact. It supports file transfer.

To read only some accounts, give container IDs as `collectionIds` in the second argument: `new AppleContactsSource(undefined, { collectionIds })`.

Access: macOS protects the AddressBook folder with the Contacts privacy service. Give the app that runs the pipeline, such as the terminal, Contacts access or Full Disk Access. If you dismiss the Contacts prompt, macOS records a denial and does not show the prompt again. A store or `Sources` folder that the source cannot open fails the run with `ContactsUnavailableError` before a copy starts. A store without a column or entity that the source reads fails with `ContactsSchemaError`.

Limitations:

- Every stream is a snapshot stream. Labeled values have no modification date, and deleted records leave no row. Thus each run reads every row. A record that is no longer in its store is deleted from the destination.
- The stores do not name their accounts. `containers.name` is null.
- For iCloud contacts, the Mac keeps only the thumbnail. The full photo stays in iCloud.
- Each store is read in its own transaction. Thus two accounts can show different times.
- Smart and subscribed groups, subscribed contacts, calendar URIs, likenesses, alert tones, custom property values, remote locations, unknown vCard lines and distribution list choices are not verified with real data.

See [docs/reference.md](../../../../docs/reference.md#apple-contacts).
