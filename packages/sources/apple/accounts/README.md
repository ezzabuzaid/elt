# @workspace/source-apple-accounts

An ELT source for the macOS Accounts store, `~/Library/Accounts/Accounts4.sqlite`. macOS keeps in this store every account that its apps sync through, such as iCloud and Google. The source reads the file on this Mac. It does not use the network, the Accounts framework or app scripting, and no app has to be open.

```ts
import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';
import { AppleAccountsSource } from '@workspace/source-apple-accounts/apple-accounts-source';

const source = new AppleAccountsSource();
const destination = new SQLiteDestination({ path: './accounts.sqlite' });

await new Pipeline({
  history: new SQLiteSyncHistory(),
  connections: [
    new Connection({
      name: 'apple-accounts',
      source,
      destination,
      checkpoints: new SQLiteCheckpointStore({
        path: './accounts-state.sqlite',
      }),
      steps: [source.accounts, source.accountDataclasses].map(
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

| Stream               | One record per                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `accounts`           | account: parent, type, sign-in state, date added, owner app, name, full name and email addresses |
| `accountProperties`  | property of an account, decoded to JSON                                                          |
| `accountDataclasses` | data class that an account offers or has turned on                                               |
| `accountTypes`       | kind of account, with the data classes that it can offer and sync                                |
| `dataclasses`        | kind of data that accounts sync, such as mail or calendars                                       |
| `accessOptionKeys`   | option key that an app gives to ask for access to a kind of account                              |
| `authorizations`     | app that has access to a kind of account                                                         |
| `credentialItems`    | expiry date of a stored credential                                                               |

Access: the store needs Full Disk Access for the app that runs the pipeline, such as the terminal. Without it, every stream fails with `AccountsUnavailableError`, which names the grant. If a macOS version does not have a column that the source reads, only the streams that read that table fail, with `AccountsSchemaError`.

Limitations:

- Every stream is a snapshot stream. Each run reads the full store. A record that is no longer in the store is deleted from the destination.
- The store holds no passwords. The credentials are in the keychain, and the source does not read them. The source also does not load the authentication material in the account properties.
- The values of `authorizations` and `credentialItems` are not verified on a real Mac, because no store that was examined had rows in them.

See [docs/reference.md](../../../../docs/reference.md#apple-accounts).
