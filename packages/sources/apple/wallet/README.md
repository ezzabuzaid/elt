# @workspace/source-apple-wallet

An ELT source for the Wallet passes on this Mac. It reads `~/Library/Passes`: passd records each pass in `passes23.sqlite`, and `Cards/<id>.pkpass/` holds the bundle that the issuer signed. The source does not use Wallet or PassKit, and no app must be open.

```ts
import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';
import { AppleWalletSource } from '@workspace/source-apple-wallet/apple-wallet-source';

const source = new AppleWalletSource();
const destination = new SQLiteDestination({ path: './wallet.sqlite' });

await new Pipeline({
  history: new SQLiteSyncHistory(),
  connections: [
    new Connection({
      name: 'apple-wallet',
      source,
      destination,
      checkpoints: new SQLiteCheckpointStore({
        path: './wallet-state.sqlite',
      }),
      steps: [source.passes, source.passFields, source.passBarcodes].map(
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

To read another folder, give it to the constructor: `new AppleWalletSource({ directory })`.

| Stream              | One record per                                                |
| ------------------- | ------------------------------------------------------------- |
| `passes`            | pass: issuer, kind, dates, colors, and when Wallet added it   |
| `passFields`        | field that the pass shows, on its front or on its back        |
| `passBarcodes`      | barcode: format, message, encoding and alt text               |
| `passLocations`     | place where Wallet shows the pass on the Lock Screen          |
| `passBeacons`       | Bluetooth beacon near which Wallet shows the pass             |
| `passRelevantDates` | moment or interval when the pass is relevant                  |
| `passLocalizations` | text that a pass translates, by language and localization key |
| `passImages`        | image in the bundle, with the image as its file               |

Every stream other than `passes` refers to the pass by `passId`.

## Access

The source needs no grant. When the store does not open, for example on a Mac where Wallet was never used, every stream fails with `WalletUnavailableError`. When a passd column that the SDK reads is missing, every stream fails with `MissingColumnsError`. When a pass has no bundle, or the reader cannot decode its `pass.json`, the read fails with `PassBundleError`, which names the pass.

## Limitations

- Each run reads every pass. When the user removes a pass, the source deletes it with its fields, barcodes and images.
- passd gets changes from other devices through iCloud about one time each day. Thus a pass that the user removed on the iPhone can stay for up to one day.
- `authenticationToken` does not load.
- The source does not read payment cards, Wallet orders, Apple Card or Apple Cash.

See [docs/reference.md](../../../../docs/reference.md#apple-wallet).
