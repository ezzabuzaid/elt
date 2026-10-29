# @workspace/source-apple-wallet

An ELT source for the Wallet passes on this Mac. It reads `~/Library/Passes`, where passd keeps the Wallet passes of this Mac, with the SDK `@workspace/sdk-apple-wallet`. `passes23.sqlite` records each pass, and `Cards/<id>.pkpass/` holds the bundle that the issuer signed. The source does not use Wallet or PassKit, and no app has to be open. PassKit shows an app only the passes of the types that its entitlement names.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md), and the glossary of [elt](../../../elt/CONTEXT.md) for the words of all of elt.

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

To read a different folder, give it to the constructor: `new AppleWalletSource({ directory })`.

A Context Compiler import loads every stream incrementally into its `data.sqlite`. Readers use its `<snake_stream>` views (`passes`, `pass_fields`, `pass_barcodes`, …). Passes come from Pass Viewer, which adds a `.pkpass` file to Wallet on this Mac, and from the iPhone of the user through iCloud.

## Access

The source needs no grant. On 2026-10-10, a launchd job without Full Disk Access read `passes23.sqlite` and a `pass.json`. The same job got `authorization denied` from the Notification Center store. When the store does not open, for example on a Mac where Wallet was never used, every stream fails with `WalletUnavailableError`, a `config` failure.

## Streams

| Stream              | Upstream                                                    | One record for each                                                                          |
| ------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `passes`            | `pass`, `pass_annotations`, the `pass.json` of the bundle   | pass: issuer, kind, dates, colors, semantic tags, when Wallet added, updated and archived it |
| `passFields`        | the `<area>Fields` arrays of `pass.json`                    | field that the pass shows, on its front or on its back: a gate, a seat, a balance            |
| `passBarcodes`      | `barcodes` of `pass.json`, or `barcode` when it has no list | barcode: format, the message that a scanner reads, its encoding and alt text                 |
| `passLocations`     | `locations` of `pass.json`                                  | place where Wallet shows the pass on the Lock Screen                                         |
| `passBeacons`       | `beacons` of `pass.json`                                    | Bluetooth beacon near which Wallet shows the pass                                            |
| `passRelevantDates` | `relevantDates` of `pass.json` (iOS 18 and later)           | moment or interval when the pass is relevant                                                 |
| `passLocalizations` | each `<language>.lproj/pass.strings`                        | text that a pass translates, by language and localization key                                |
| `passImages`        | the images that `manifest.json` lists                       | image in the bundle, with the image as its file                                              |

The `id` of a pass is the `unique_id` of passd, which also names its bundle. `passTypeIdentifier` and `serialNumber` are the identity that the issuer gives the pass. The `passId` of every other stream refers to `id`.

The source reads the content of `pass.json` from the bundle, not from the copies of passd (`relevant_pass_dates`, `location`), because the bundle keeps what the copies lose: the offset of a date ([ADR 0001](./docs/adr/0001-the-content-of-a-pass-comes-from-its-bundle.md)). The dates of PassKit are W3C dates with a time zone, for example a departure at `2025-09-15T09:30+08:00`. Each date loads as a UTC [`date-time`](../../../elt/README.md#string-formats) to the millisecond (`relevantAt`) and the offset in minutes that it was written with (`relevantAtOffset`). The SQL Server source uses the same convention. A date without a time zone fails the read.

A `value` of a field loads as `pass.json` writes it: text or a localization key, a W3C date that `dateStyle` formats, or the digits of a number. Numbers are read through the source text of `JSON.parse`, so a value that a double cannot hold keeps every digit. `semantics`, `userInfo`, `personalization` and `passJson` keep numbers in the same way. `passJson` is the full `pass.json` without `authenticationToken`. This token is the credential for the web service of the issuer, and it does not load ([ADR 0002](./docs/adr/0002-the-authentication-token-does-not-load.md)). Barcode messages load, because the pass shows them for scanning.

A text that a pass localizes is its key in `pass.json`. `passLocalizations` holds the text of each language from `pass.strings`, in UTF-8 or UTF-16 (`plutil` reads both). The source does not choose a language: a reader joins on `passId` and `key`. Fields are keyed by their area and position, because an issuer can use a key more than one time.

The dates of passd (`addedAt` from `ingested_date`, `updatedAt` from `modified_date`, `archivedAt` from `pass_annotations.archived_timestamp`) are seconds since 2001-01-01 in a double, written to the microsecond. `signedAt` is the time of the signature, to the second. `sortingState` is `pass_annotations.sorting_state`. The predicates of passd use it to put the current passes of Wallet in the stack and the expired passes in a different section. Apple does not document the codes. On this Mac, it was 0 on the passes without `archivedAt`, and 1 on a boarding pass that was added one day after its flight and archived when it was added. An expired or voided pass stays in Wallet, and it loads with `expiresAt` and `voided`.

The source does not read these:

- `pass_group`. Its `group_order` is the display order of Wallet, and it changes for every pass when a pass is added (seen live). Thus loading it would write every pass again at each add ([ADR 0003](./docs/adr/0003-the-display-order-of-wallet-does-not-load.md)).
- `pass_type` and `web_service`, which repeat the identifiers and the URL of `pass.json` next to the push token.
- The columns of payment cards, and `payment_transaction`. They were empty on this Mac, which has no card.
- The `signature` of the bundles, and the rendered faces in `Cards/<id>.cache/`.
- The FinanceKit stores in `~/Library/Finance`, which hold Wallet orders and Apple Card and Apple Cash. They never stored a row on this Mac (backlog item 2537).

## Changes and deletions

Every stream is a [snapshot stream](../../../elt/README.md#snapshot-streams) with deletions: a run reads every pass, a record that did not change writes nothing, and a pass that the user removes is deleted with its fields, barcodes and images. This is true for a removal on this Mac and on a device that syncs Wallet through iCloud. passd keeps no record of the removal. An update by the issuer replaces the bundle and `modified_date`, and the records that changed load in place.

A pass whose bundle is missing, or whose `pass.json` the reader cannot decode, fails the read with `PassBundleError`, which names the pass. The source does not leave the pass out, so the destination keeps its rows. The SDK checks every column that it reads when it opens the database. If a passd layout does not have one of them, every stream fails with `MissingColumnsError`.

A change on a different device gets to this Mac only when passd fetches the iCloud zone of Wallet. Its scheduled activities (`PDPassSyncActivityIdentifier`, `PDCloudSyncCoordinator…` in `ScheduledActivities.archive`) do this every 86,400 s. Its `cloud_store_zone.fetch_timestamp` read 2026-10-10 00:14 UTC. A pass removed on the iPhone at about 08:55 UTC on that day was still in the store of this Mac 45 minutes later (backlog item 2547). A pass added on this Mac got to iCloud in 16 s. Thus the destination can hold a pass that the iPhone removed for up to one day.

Thus the source is current only as of that fetch ([ADR 0004](./docs/adr/0004-wallet-is-current-as-of-the-last-icloud-fetch-of-passd.md)). `currentAsOf` gives the earliest `fetch_timestamp` of the `passes` zones of passd, or null when passd never fetched them.

passd commits through a rollback journal, not a write-ahead log. Thus a reader that holds the database stops its commits. The SDK reads the rows of passd in one read transaction, and closes the database before it reads the bundles.

## Watching

A watch polls the `data_version` of `passes23.sqlite` every second through `WalletStore.version()`. On a commit, it wakes every selected stream. On 2026-10-10, a read-only connection saw passd commit two times when a pass was added (one time at the add, and one time 16 s later), and not at all in the other 30 idle minutes. FSEvents on `Cards/` would not see archiving, which changes only the database. The PassKit notification `com.apple.passkit.sharedcachechanged` fired two times in that half hour, and no pass changed.

## Live checks

Checked live on 2026-10-10 on macOS 27.0 (26A428):

- The store held 4 passes from 2025-08-19: two Qatar Airways boarding passes and two Genius Bar reservations. Their `pass.json` dates kept the offsets +02:00, +08:00 and +04:00, and the times in the database agreed with them.
- A pass made with WalletWallet (a third-party signer, with dummy data: a generic pass with one location, both `barcode` and `barcodes`, and an expiry in UTC with milliseconds) was added through Add to Wallet in Pass Viewer. passd stored it with `modified_source` 4, where the synced passes had 5. It gave the pass `group_order` 0 and moved the order of every other pass by one.
- A load through the Context Compiler CLI, run from a scratch folder so that the selection of the user stayed as it was, took 0.78 s. It wrote the 5 passes, 46 fields, 5 barcodes, 3 locations and 34 images. A second load wrote nothing. `/usr/bin/sqlite3` read every view, and every stored image was on disk. The `authenticationToken` of none of the 4 passes was in any of the 38 files of the import. The serial number, the expiry and the number of places of each pass agreed with the record of passd.

Not verified: localizations, beacons, `relevantDates`, `personalization.json`, and a new version of a pass that replaces the old one. No pass on this Mac has the first four, and the form of WalletWallet writes none of them. Its generator gives each pass a new random serial number, so it cannot make a second version of a pass. The tests use only the documented format of PassKit for these. To make them live, you need a signer that controls the full `pass.json` and its serial number: a Pass Type ID certificate in the developer account, or the API of WalletWallet with a key. Payment cards were not read: no card is on this Mac, and adding one needs a real card.

## Limitations

- Each run reads every pass. When the user removes a pass, the source deletes it with its fields, barcodes and images.
- passd gets changes from other devices through iCloud about one time each day. Thus a pass that the user removed on the iPhone can stay for up to one day.
- `authenticationToken` does not load.
- The source does not read payment cards, Wallet orders, Apple Card or Apple Cash.

## Decisions

- [ADR 0001](./docs/adr/0001-the-content-of-a-pass-comes-from-its-bundle.md): the content of a pass comes from its bundle.
- [ADR 0002](./docs/adr/0002-the-authentication-token-does-not-load.md): the authentication token does not load.
- [ADR 0003](./docs/adr/0003-the-display-order-of-wallet-does-not-load.md): the display order of Wallet does not load.
- [ADR 0004](./docs/adr/0004-wallet-is-current-as-of-the-last-icloud-fetch-of-passd.md): Wallet is current as of the last iCloud fetch of passd.

## Development

Run the commands from the workspace root.

```sh
npx nx run source-apple-wallet:test        # builds, then runs src/*.test.ts
npx nx run source-apple-wallet:typecheck   # formats, lints, then type checks
```
