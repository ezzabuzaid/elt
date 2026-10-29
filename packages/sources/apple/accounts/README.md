# @workspace/source-apple-accounts

An ELT source for the macOS Accounts store, `~/Library/Accounts/Accounts4.sqlite`. macOS keeps in this store every account that its apps sync through, such as iCloud and Google. The source reads the file on this Mac with the SDK `@workspace/sdk-apple-accounts`. It does not use the network, the Accounts framework or app scripting, and no app has to be open.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md), and the glossary of [elt](../../../elt/CONTEXT.md) for the words of all of elt.

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

To read a different store, give its path to the constructor: `new AppleAccountsSource({ path })`.

A Context Compiler import loads every stream incrementally into its `data.sqlite`. Readers use its `<snake_stream>` views. Every stream of a run reads one snapshot of the store: a read transaction on a read-only connection. The connection is never `immutable`, because accountsd keeps a write-ahead log.

## Access

The store needs [Full Disk Access](../messages/README.md) for the app that runs the pipeline, such as the terminal. On 2026-10-05, a terminal with the grant read the store. A launchd job without the grant got the SQLite error CANTOPEN (14). The same job got CANTOPEN for `~/Library/Messages/chat.db`, and `EPERM` when it listed `~/Library/Mail`. When the process cannot open the store, every stream fails with `AccountsUnavailableError`, which names the grant.

## Streams

| Stream               | Upstream                                                            | One record for each                                                                                    |
| -------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `accounts`           | `ZACCOUNT`                                                          | account: parent, type, sign-in state, date added, owner app, the settings of each data class as JSON   |
| `accountProperties`  | `ZACCOUNTPROPERTY`                                                  | property of an account, with its keyed archive decoded to JSON                                         |
| `accountDataclasses` | `Z_*ENABLEDDATACLASSES`, `Z_*PROVISIONEDDATACLASSES`                | data class that an account offers or has turned on                                                     |
| `accountTypes`       | `ZACCOUNTTYPE`, `Z_*SUPPORTEDDATACLASSES`, `Z_*SYNCABLEDATACLASSES` | account type, with the data classes that it can offer and sync, as arrays                              |
| `dataclasses`        | `ZDATACLASS`                                                        | data class: a kind of data that accounts sync, such as mail or calendars                               |
| `accessOptionKeys`   | `ZACCESSOPTIONSKEY`, `Z_*OWNINGACCOUNTTYPES`                        | option key that an app gives to ask for access to an account type                                      |
| `authorizations`     | `ZAUTHORIZATION`                                                    | app that has access to an account type                                                                 |
| `credentialItems`    | `ZCREDENTIALITEM`                                                   | expiry date of a stored credential; the credential is in the keychain, and the source does not read it |

Core Data names the join tables after entity numbers, and these numbers change between model versions (`Z_2ENABLEDDATACLASSES` on macOS 27). Thus the SDK finds each join table by the end of its name. When a join table is not there, the read fails with `AccountsSchemaError`, which names the table.

`accounts` also has `name`, `fullName` and `emailAddresses`. The SDK resolves them through the parent account, as Mail does:

- `name` is the description of the account, else the description of the parent (iCloud, Google).
- `fullName` is the full name property of the account, else the one of the parent.
- `emailAddresses` has, in this order, the identity addresses of the account and of its parent, then their aliases, then their Apple ID aliases, then their iCloud Mail addresses. Each address is in the list one time.

Dates are Core Data seconds since 2001-01-01. SQLite converts them, and they are rounded to the millisecond. A boolean that the store does not hold is null.

The source does not read these:

- Authentication material in the properties ([ADR 0002](./docs/adr/0002-authentication-material-does-not-load.md)): the encrypted last sign-in response of the iTunes Store (`lastAuthenticationServerResponse`), the next liveness nonce of the Apple ID (`nextLivenessNonce`) and the opaque player record of Game Center (`GKPlayerInternal`), all three in full, and `AuthID` in the `account-info` of the identity service. The store holds no passwords.
- The bookkeeping of Core Data: `Z_METADATA`, `Z_MODELCACHE` and `Z_PRIMARYKEY`.

## Changes and deletions

Every stream is a [snapshot stream](../../../elt/README.md): a run reads the full store, a record that did not change writes nothing, and a key that is no longer in the store deletes its row. The store is small, so a run reads it in less than one second.

Each kind of record checks only the columns that it reads ([ADR 0001](./docs/adr/0001-each-read-checks-only-the-columns-of-its-tables.md)). If a macOS layout does not have one of them, only the streams that read that table fail, with `MissingColumnsError`, which names the missing columns. The other streams load. Mail reads only accounts, so it continues to load.

## Watching

A watch polls the `data_version` of the store every second through `AccountsStore.version()`. On a commit, it wakes every selected stream. accountsd commits by itself: on 2026-10-05, a read-only connection saw five commits in five minutes, and nobody changed an account. Thus a watch wakes about one time each minute, and a pass with no change writes nothing.

## Live checks

Checked live on 2026-10-05 on macOS 27.0:

- The store held 33 accounts of 19 types (31 active), 411 properties with 234 keys, 56 account types, 52 data classes and 7 access option keys (Facebook, LinkedIn, Tencent Weibo and Liverpool). It held no authorizations and no credential items.
- A load through the Context Compiler CLI took 0.4 s. It wrote 33 accounts, 408 properties (without the 3 properties of authentication material), 67 account data classes, 56 account types, 52 data classes and 7 access option keys. A second load wrote nothing.
- In the same snapshot, the type of each account, each data class that an account or a type names, and each account type that an access key names were found.
- `authorizations` and `credentialItems` read their columns as the Core Data model of AccountsDaemon (`accounts30.mom`) declares them. `Authorization.options` is transformable through `NSSecureUnarchiveFromData`, so the SDK decodes it as a keyed archive. `CredentialItem.expirationDate` is a Core Data date.

Not verified: the values of `authorizations` and `credentialItems`. The store of this Mac and its `VerifiedBackup` copy hold no row. accountsd writes these rows only for an app that has Accounts framework entitlements and asks for access to an account type, and no tool here can do that.

## Limitations

- Every stream deletes the rows of records that leave the store.
- The store holds no passwords. The credentials are in the keychain, and the source does not read them. The source also does not load the authentication material in the account properties.
- The values of `authorizations` and `credentialItems` are not verified on a real Mac.

## Decisions

- [ADR 0001](./docs/adr/0001-each-read-checks-only-the-columns-of-its-tables.md): each read checks only the columns of its tables.
- [ADR 0002](./docs/adr/0002-authentication-material-does-not-load.md): authentication material does not load.

## Development

Run the commands from the workspace root.

```sh
npx nx run source-apple-accounts:test        # builds, then runs src/*.test.ts
npx nx run source-apple-accounts:typecheck   # formats, lints, then type checks
```
