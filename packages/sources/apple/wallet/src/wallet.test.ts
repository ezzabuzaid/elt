import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { chmod, mkdtempDisposable, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import {
  Connection,
  Copy,
  type CopyResult,
  LocalFiles,
  Pipeline,
  PipelineError,
  type Target,
} from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteColumns,
  SQLiteDestination,
} from '@workspace/elt-sqlite';
import {
  PassBundleError,
  WalletSchemaError,
  WalletUnavailableError,
  walletStorePath,
} from '@workspace/sdk-apple-wallet';

import { AppleWalletSource } from './apple-wallet-source.ts';

// A pass as passd keeps it: its row in passes23.sqlite, the sorting state
// Wallet annotates it with, and its bundle's files besides manifest.json,
// which passd writes from them.
type ScratchPass = {
  readonly id: string;
  // A random 64-bit integer, as passd keys its rows.
  readonly pid: bigint;
  readonly addedAt: number;
  readonly updatedAt: number;
  readonly signedAt: number;
  readonly annotation?: {
    readonly sortingState: number;
    readonly archivedAt: number | null;
  };
  readonly files: Readonly<Record<string, string | Uint8Array>>;
};

// A synthetic Wallet store: passes23.sqlite with the pass and
// pass_annotations tables as macOS 27's passd declares them, in its rollback
// journal, and a Cards/<id>.pkpass bundle per pass.
class ScratchWallet implements Disposable {
  readonly directory: string;
  readonly #database: DatabaseSync;

  // existing opens a store already made, as passd does when it changes one.
  constructor(directory: string, { existing = false } = {}) {
    this.directory = directory;
    mkdirSync(join(directory, 'Cards'), { recursive: true });
    // passd's keys are rowids past 2^53, which only a bigint holds.
    this.#database = new DatabaseSync(join(directory, 'passes23.sqlite'), {
      readBigInts: true,
    });
    if (existing) return;
    this.#database.exec(`
      CREATE TABLE "pass" ("pid" INTEGER, "unique_id" TEXT NOT NULL, "pass_type_pid" INTEGER NOT NULL, "serial_number" TEXT NOT NULL, "sequence_counter" INTEGER, "organization_name" TEXT, "provisioning_credential_hash" TEXT, "relevant_date" INTEGER, "expiration_date" INTEGER, "signing_date" INTEGER, "voided" INTEGER, "user_info" BLOB, "template" INTEGER, "background_color" TEXT, "secondary_background_color" TEXT, "foreground_color" TEXT, "label_color" TEXT, "strip_color" TEXT, "tall_code" INTEGER, "has_background_image" INTEGER, "has_strip_image" INTEGER, "manifest_hash" BLOB, "web_service_pid" INTEGER, "push_registration_status" INTEGER, "push_registration_date" INTEGER, "authentication_token" TEXT, "last_modified_tag" TEXT, "ingested_date" INTEGER, "modified_date" INTEGER, "modified_source" INTEGER, "grouping_id" TEXT, "group_pid" INTEGER, "revoked" INTEGER, "share_count" INTEGER, "pass_transaction_service_pid" INTEGER, "pass_message_service_pid" INTEGER, "pass_flavor" INTEGER, "card_type" INTEGER, "primary_account_identifier" TEXT, "primary_account_suffix" TEXT, "sanitized_pan" TEXT, "sharing_method" INTEGER, "sharing_url" TEXT, "sharing_text" TEXT, "supports_dpan_notifications" INTEGER, "supports_fpan_notifications" INTEGER, "supports_default_card_selection" INTEGER, "is_shell_pass" INTEGER, "supports_serial_number_based_provisioning" INTEGER, "requires_transfer_serial_number_based_provisioning" INTEGER, "has_stored_value" INTEGER, "contactless_activation_grouping_type" INTEGER, "pass_default_payment_application_pid" INTEGER, "cobranded" INTEGER, "low_balance_reminder_amount" INTEGER, "low_balance_reminder_currency" TEXT, "commute_plan_renewal_reminder_time_interval" INTEGER, "issuer_country_code" TEXT, "has_associated_peer_payment_account" INTEGER, "is_cloud_kit_archived" INTEGER, "cloud_kit_metadata" BLOB, "is_cloud_kit_securely_archived" INTEGER, "cloud_kit_secure_metadata" BLOB, "a" TEXT, "b" INTEGER, "c" TEXT, "transaction_source_pid" INTEGER, "d" TEXT, "e" TEXT, "mute_ready_for_use_notification" INTEGER DEFAULT 0, "live_render_background_type" TEXT, "f" TEXT, "g" TEXT, "shipping_address_seed" TEXT, "supports_issuer_binding" INTEGER DEFAULT 0, "original_provisioning_date" INTEGER, "live_rendering_requires_enablement" INTEGER, "transfer_url" TEXT, "sell_url" TEXT, "bag_policy_url" TEXT, "order_food_url" TEXT, "transit_information_url" TEXT, "parking_information_url" TEXT, "directions_information_url" TEXT, "merchandise_url" TEXT, "accessibility_url" TEXT, "purchase_parking_url" TEXT, "add_on_url" TEXT, "contact_venue_phone_number" TEXT, "contact_venue_email" TEXT, "contact_venue_website" TEXT, "supports_automatic_foreground_vibrancy" INTEGER, "supports_automatic_label_vibrancy" INTEGER, "footer_background_color" TEXT, "suppress_header_darkening" INTEGER, "h" TEXT, "i" TEXT, "j" TEXT, "k" TEXT, "m" TEXT, "n" TEXT, p TEXT, q TEXT, r TEXT, s TEXT, t TEXT, u TEXT, v TEXT, identity_pass_type INTEGER, access_pass_type INTEGER, w TEXT, access_reporting_type TEXT, l TEXT, size_class INTEGER, x TEXT, draw_card_holder_image_on_artwork INTEGER, transit_pass_type INTEGER, is_user_pass INTEGER DEFAULT 0, PRIMARY KEY (pid));
      CREATE INDEX pass_flavor_index ON pass (pass_flavor);
      CREATE INDEX pass_unique_id_index ON pass (unique_id);
      CREATE TABLE pass_annotations (pass_pid INTEGER, sorting_state INTEGER, archived_timestamp INTEGER, PRIMARY KEY (pass_pid));
    `);
  }

  add(pass: ScratchPass): void {
    this.#database
      .prepare(
        'INSERT INTO pass (pid, unique_id, pass_type_pid, serial_number, ingested_date, modified_date, signing_date, modified_source) VALUES (?, ?, 1, ?, ?, ?, ?, 4)',
      )
      .run(
        pass.pid,
        pass.id,
        serialNumber(pass),
        pass.addedAt,
        pass.updatedAt,
        pass.signedAt,
      );
    if (pass.annotation !== undefined)
      this.#database
        .prepare('INSERT INTO pass_annotations VALUES (?, ?, ?)')
        .run(
          pass.pid,
          pass.annotation.sortingState,
          pass.annotation.archivedAt,
        );
    this.#writeBundle(pass);
  }

  // A new version of a pass the issuer sent: passd rewrites its bundle and
  // the dates its row keeps.
  update(pass: ScratchPass): void {
    this.#database
      .prepare(
        'UPDATE pass SET modified_date = ?, signing_date = ? WHERE unique_id = ?',
      )
      .run(pass.updatedAt, pass.signedAt, pass.id);
    rmSync(this.bundle(pass.id), { recursive: true, force: true });
    this.#writeBundle(pass);
  }

  // A pass the user removed: passd deletes its rows and its bundle.
  remove(pass: ScratchPass): void {
    this.#database.prepare('DELETE FROM pass WHERE pid = ?').run(pass.pid);
    this.#database
      .prepare('DELETE FROM pass_annotations WHERE pass_pid = ?')
      .run(pass.pid);
    rmSync(this.bundle(pass.id), { recursive: true });
  }

  exec(sql: string): void {
    this.#database.exec(sql);
  }

  bundle(id: string): string {
    return join(this.directory, 'Cards', `${id}.pkpass`);
  }

  #writeBundle(pass: ScratchPass): void {
    const manifest: Record<string, string> = {};
    for (const [path, content] of Object.entries(pass.files)) {
      const file = join(this.bundle(pass.id), path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
      manifest[path] = createHash('sha1').update(content).digest('hex');
    }
    writeFileSync(
      join(this.bundle(pass.id), 'manifest.json'),
      JSON.stringify(manifest),
    );
  }

  [Symbol.dispose](): void {
    this.#database.close();
  }
}

function serialNumber(pass: ScratchPass): string {
  const json: unknown = JSON.parse(String(pass.files['pass.json']));
  if (
    typeof json !== 'object' ||
    json === null ||
    !('serialNumber' in json) ||
    typeof json.serialNumber !== 'string'
  )
    throw new TypeError(`Scratch pass ${pass.id} names no serial number`);
  return json.serialNumber;
}

// passd's dates are seconds since 2001-01-01 in a double.
const appleTime = (iso: string, micros = 0) =>
  Date.parse(iso) / 1000 - 978307200 + micros / 1e6;

// Two one-pixel PNGs, as an issuer's images arrive.
const redPixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);
const bluePixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==',
  'base64',
);

// A boarding pass as an airline issues it: fields in four areas, a barcode
// list beside the legacy barcode, a departure written in the airport's
// local time, semantic tags, a web service with its token, images at two
// scales, and English and Arabic text.
const boardingPass: ScratchPass = {
  id: 'Rj5JgNLqUsLcgX514jcGtHwF+aI=',
  pid: -6751586574849564982n,
  addedAt: appleTime('2025-09-15T09:28:20Z', 663083),
  updatedAt: appleTime('2025-09-15T09:28:20Z', 977644),
  signedAt: appleTime('2025-09-14T22:07:46Z'),
  annotation: { sortingState: 0, archivedAt: null },
  files: {
    'pass.json': JSON.stringify({
      formatVersion: 1,
      passTypeIdentifier: 'pass.com.example.airline',
      serialNumber: 'BP-845',
      teamIdentifier: 'TEAM123456',
      organizationName: 'Example Air',
      description: 'BOARDING_PASS',
      logoText: 'Example Air',
      groupingIdentifier: 'BOOKING-9U5XWF',
      relevantDate: '2025-09-15T09:30+08:00',
      associatedStoreIdentifiers: [581264644],
      appLaunchURL: 'exampleair://booking/9U5XWF',
      webServiceURL: 'https://passes.example.com/v1',
      authenticationToken: 'token-that-must-not-load',
      sharingProhibited: true,
      foregroundColor: 'rgb(144,6,82)',
      backgroundColor: 'rgb(246,246,246)',
      labelColor: 'rgb(116,127,138)',
      semantics: {
        airlineCode: 'EA',
        flightNumber: 845,
        departureAirportCode: 'KUL',
        destinationAirportCode: 'DOH',
      },
      userInfo: { booking: '9U5XWF' },
      barcode: {
        format: 'PKBarcodeFormatPDF417',
        message: 'LEGACY-BP-845',
        messageEncoding: 'iso-8859-1',
      },
      barcodes: [
        {
          format: 'PKBarcodeFormatQR',
          message: 'M1RIVERA/SAM E9U5XWF KULDOHEA 0845',
          messageEncoding: 'iso-8859-1',
          altText: '9U5XWF',
        },
        {
          format: 'PKBarcodeFormatPDF417',
          message: 'M1RIVERA/SAM E9U5XWF KULDOHEA 0845',
          messageEncoding: 'iso-8859-1',
        },
      ],
      boardingPass: {
        transitType: 'PKTransitTypeAir',
        headerFields: [
          {
            key: 'boarding-gate',
            label: 'GATE',
            value: 'C1',
            textAlignment: 'PKTextAlignmentRight',
            changeMessage: 'Gate changed to %@',
          },
        ],
        primaryFields: [
          { key: 'origin', label: 'KUALA_LUMPUR', value: 'KUL' },
          { key: 'destination', label: 'DOHA', value: 'DOH' },
        ],
        auxiliaryFields: [
          {
            key: 'departure',
            label: 'DEPARTS',
            value: '2025-09-15T09:30+08:00',
            dateStyle: 'PKDateStyleMedium',
            timeStyle: 'PKDateStyleShort',
            ignoresTimeZone: true,
            isRelative: true,
            semantics: { originalDepartureDate: '2025-09-15T09:30+08:00' },
          },
        ],
        backFields: [
          {
            key: 'website',
            label: 'WEBSITE',
            value: 'https://example.com/9U5XWF',
            attributedValue: '<a href="https://example.com/9U5XWF">Manage</a>',
            dataDetectorTypes: ['PKDataDetectorTypeLink'],
          },
        ],
      },
    }),
    'icon.png': redPixel,
    'icon@2x.png': bluePixel,
    'en.lproj/pass.strings':
      '"BOARDING_PASS" = "Boarding pass";\n"KUALA_LUMPUR" = "Kuala Lumpur";\n',
    'ar.lproj/pass.strings': Buffer.from(
      '﻿"BOARDING_PASS" = "بطاقة صعود";\n"KUALA_LUMPUR" = "كوالالمبور";\n',
      'utf16le',
    ),
    'ar.lproj/logo.png': redPixel,
  },
};

// An event ticket made for iOS 18: a venue to show it near, a beacon, an
// interval and a moment it is relevant, an expiry, and an auxiliary row.
const eventTicket: ScratchPass = {
  id: 'DBOQyV1BAwPyPhYRvYyhG8eusUE=',
  pid: -269134946572782675n,
  addedAt: appleTime('2026-02-10T18:58:50Z', 405923),
  updatedAt: appleTime('2026-02-10T18:58:50Z', 447005),
  signedAt: appleTime('2026-02-10T18:52:01Z'),
  files: {
    'pass.json': JSON.stringify({
      formatVersion: 1,
      passTypeIdentifier: 'pass.com.example.venue',
      serialNumber: 'TICKET-1',
      teamIdentifier: 'TEAM654321',
      organizationName: 'Example Hall',
      description: 'Concert ticket',
      expirationDate: '2026-02-13T23:00:00.250Z',
      maxDistance: 120.5,
      locations: [
        {
          latitude: 25.195613989,
          longitude: 55.277543085,
          altitude: 12.5,
          relevantText: 'Doors open at 8',
        },
      ],
      beacons: [
        {
          proximityUUID: 'E2C56DB5-DFFB-48D2-B060-D0F5A71096E0',
          major: 1,
          minor: 65535,
          relevantText: 'Welcome',
        },
      ],
      relevantDates: [
        {
          startDate: '2026-02-13T20:00+04:00',
          endDate: '2026-02-13T23:00+04:00',
        },
        { date: '2026-02-13T19:30-05:30' },
      ],
      barcodes: [
        {
          format: 'PKBarcodeFormatAztec',
          message: 'TICKET-1-SEAT-A12',
          messageEncoding: 'utf-8',
        },
      ],
      eventTicket: {
        primaryFields: [{ key: 'event', value: 'Night Concert' }],
        auxiliaryFields: [{ key: 'seat', label: 'SEAT', value: 'A12', row: 1 }],
      },
    }),
    'strip.png': redPixel,
  },
};

// A store card, the only kind here with personalization.json, whose balance
// an issuer may write as a number no double holds.
const storeCard: ScratchPass = {
  id: 'nOg2bVYUyXuEZC0szfn89-+rtyE=',
  pid: 7514561053096528262n,
  addedAt: appleTime('2026-03-01T08:00:00Z', 1),
  updatedAt: appleTime('2026-03-01T08:00:00Z', 2),
  signedAt: appleTime('2026-03-01T07:59:00Z'),
  annotation: { sortingState: 0, archivedAt: null },
  files: {
    'pass.json': `{"formatVersion":1,"passTypeIdentifier":"pass.com.example.cafe","serialNumber":"CARD-1","teamIdentifier":"TEAM777777","organizationName":"Example Cafe","description":"Rewards card","semantics":{"balance":{"amount":12345678901234567890.25,"currencyCode":"USD"}},"storeCard":{"primaryFields":[{"key":"balance","label":"BALANCE","value":12345678901234567890.25,"currencyCode":"USD","numberStyle":"PKNumberStyleDecimal"}]}}`,
    'personalization.json': JSON.stringify({
      requiredPersonalizationFields: [
        'PKPassPersonalizationFieldName',
        'PKPassPersonalizationFieldEmailAddress',
      ],
      description: 'Join for a free drink',
    }),
    'thumbnail.png': bluePixel,
  },
};

function walletFixture(directory: string): void {
  using wallet = new ScratchWallet(directory);
  wallet.add(boardingPass);
  wallet.add(eventTicket);
  wallet.add(storeCard);
}

function rows(path: string, sql: string) {
  using db = new DatabaseSync(path, { readOnly: true });
  return db
    .prepare(sql)
    .all()
    .map((row) => ({ ...row }));
}

// Every Wallet stream loaded incrementally as the Apple hosts load it, image
// files exported beside the database into attachmentRef.
async function pipeline(source: AppleWalletSource, directory: string) {
  const destination = new SQLiteDestination({
    path: join(directory, 'out.sqlite'),
  });
  const files = new LocalFiles({ directory: join(directory, 'files') });
  const { streams } = await source.discover();
  return new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints: new SQLiteCheckpointStore({
          path: join(directory, 'state.sqlite'),
        }),
        steps: streams.map(
          (stream) =>
            new Copy(
              stream,
              destination.table(
                stream.name,
                stream.supportsFileTransfer
                  ? (columns) => [
                      ...SQLiteColumns.fromSchema(stream.jsonSchema),
                      columns
                        .text('attachmentRef')
                        .from(stream.file.store(files)),
                    ]
                  : undefined,
              ),
              {
                id: stream.name,
                syncMode: 'incremental',
                destinationSyncMode: 'append_dedup',
              },
            ),
        ),
      }),
    ],
  });
}

const counts = (results: readonly CopyResult<Target>[]) =>
  Object.fromEntries(
    results.map(({ copy, count, deleted }) => [
      copy.from.name,
      { count, deleted },
    ]),
  );

const streamNames = [
  'passes',
  'passFields',
  'passBarcodes',
  'passLocations',
  'passBeacons',
  'passRelevantDates',
  'passLocalizations',
  'passImages',
];

// How many rows each stream's table holds.
const tableSizes = (out: string) =>
  Object.fromEntries(
    streamNames.map((name) => [
      name,
      rows(out, `SELECT count(*) AS n FROM ${name}`)[0]?.n,
    ]),
  );

test('a pass whose bundle cannot be read fails the run, naming the pass, and every loaded row stays', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'elt-wallet-'));
  walletFixture(dir.path);
  const run = await pipeline(
    new AppleWalletSource({ directory: dir.path }),
    dir.path,
  );
  const out = join(dir.path, 'out.sqlite');
  await run.run();
  const loaded = tableSizes(out);
  using wallet = new ScratchWallet(dir.path, { existing: true });
  const bundle = wallet.bundle(eventTicket.id);
  const breakages = [
    // A bundle gone while its row stays.
    () => rmSync(bundle, { recursive: true }),
    // A pass.json whose date has no time zone, which PassKit's format
    // requires.
    () => {
      wallet.update({
        ...eventTicket,
        files: {
          ...eventTicket.files,
          'pass.json': String(eventTicket.files['pass.json']).replace(
            '2026-02-13T23:00:00.250Z',
            '2026-02-13T23:00',
          ),
        },
      });
    },
  ];

  for (const breakage of breakages) {
    wallet.update(eventTicket);
    breakage();

    await assert.rejects(run.run(), (error) => {
      assert.ok(error instanceof PipelineError);
      assert.equal(error.errors.length, streamNames.length);
      for (const cause of error.errors) {
        assert.ok(cause instanceof PassBundleError);
        assert.ok(cause.message.includes(eventTicket.id));
      }
      return true;
    });
    assert.deepEqual(tableSizes(out), loaded);
  }
});

// Each kind of failure a run's copies reported, once.
function failureTypes(error: PipelineError<Target>): string[] {
  return [
    ...new Set(
      error.results.flatMap(({ failures }) =>
        failures.map(({ failureType }) => failureType),
      ),
    ),
  ];
}

test('a store that cannot be opened fails every stream as the user’s to fix, and keeps what loaded', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'elt-wallet-'));
  walletFixture(dir.path);
  const run = await pipeline(
    new AppleWalletSource({ directory: dir.path }),
    dir.path,
  );
  const out = join(dir.path, 'out.sqlite');
  await run.run();
  const loaded = tableSizes(out);
  const database = join(dir.path, 'passes23.sqlite');
  // chmod stands in for a store macOS keeps out of reach; SQLite reports
  // CANTOPEN either way.
  await chmod(database, 0o000);

  try {
    await assert.rejects(run.run(), (error) => {
      assert.ok(error instanceof PipelineError);
      assert.equal(error.errors.length, streamNames.length);
      for (const cause of error.errors) {
        assert.ok(cause instanceof WalletUnavailableError);
        assert.ok(cause.message.includes(database));
      }
      assert.deepEqual(failureTypes(error), ['config']);
      return true;
    });
  } finally {
    await chmod(database, 0o644);
  }

  assert.deepEqual(tableSizes(out), loaded);
});

test('a store missing a column this reader reads fails every stream by name and keeps what loaded', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'elt-wallet-'));
  walletFixture(dir.path);
  const run = await pipeline(
    new AppleWalletSource({ directory: dir.path }),
    dir.path,
  );
  const out = join(dir.path, 'out.sqlite');
  await run.run();
  const loaded = tableSizes(out);
  {
    using passd = new ScratchWallet(dir.path, { existing: true });
    passd.exec('ALTER TABLE pass_annotations DROP COLUMN archived_timestamp');
  }

  await assert.rejects(run.run(), (error) => {
    assert.ok(error instanceof PipelineError);
    assert.equal(error.errors.length, streamNames.length);
    for (const cause of error.errors) {
      assert.ok(cause instanceof WalletSchemaError);
      assert.match(cause.message, /pass_annotations\.archived_timestamp/);
    }
    assert.deepEqual(failureTypes(error), ['system']);
    return true;
  });
  assert.deepEqual(tableSizes(out), loaded);
});

// Every file under a directory, by its path.
async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

test('a pass’s authenticationToken reaches nothing an import writes', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'elt-wallet-'));
  const store = join(dir.path, 'Library/Passes');
  walletFixture(store);
  const run = await pipeline(
    new AppleWalletSource({ directory: store }),
    join(dir.path, 'import'),
  );

  await run.run();

  const written = await filesUnder(join(dir.path, 'import'));
  assert.ok(written.some((file) => file.endsWith('out.sqlite')));
  for (const file of written)
    assert.ok(
      !(await readFile(file)).includes('token-that-must-not-load'),
      `${file} holds the token`,
    );
  const [loaded] = rows(
    join(dir.path, 'import/out.sqlite'),
    `SELECT webServiceUrl, passJson FROM passes WHERE id = '${boardingPass.id}'`,
  );
  assert.equal(loaded?.webServiceUrl, 'https://passes.example.com/v1');
  assert.ok(String(loaded?.passJson).includes('"webServiceURL"'));
});

test('a date written with an offset loads as UTC and its offset, and a number past 2^53 keeps every digit', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'elt-wallet-'));
  walletFixture(dir.path);
  const run = await pipeline(
    new AppleWalletSource({ directory: dir.path }),
    dir.path,
  );
  const out = join(dir.path, 'out.sqlite');

  await run.run();

  assert.deepEqual(
    rows(
      out,
      `SELECT relevantAt, relevantAtOffset FROM passes WHERE id = '${boardingPass.id}'`,
    ),
    [{ relevantAt: '2025-09-15T01:30:00.000Z', relevantAtOffset: 480 }],
  );
  assert.deepEqual(
    rows(
      out,
      `SELECT at, atOffset FROM passRelevantDates WHERE passId = '${eventTicket.id}' AND position = 1`,
    ),
    [{ at: '2026-02-14T01:00:00.000Z', atOffset: -330 }],
  );
  assert.deepEqual(
    rows(
      out,
      `SELECT value FROM passFields WHERE passId = '${storeCard.id}' AND key = 'balance'`,
    ),
    [{ value: '12345678901234567890.25' }],
  );
  assert.deepEqual(
    rows(
      out,
      `SELECT semantics, passJson FROM passes WHERE id = '${storeCard.id}'`,
    ),
    [
      {
        semantics:
          '{"balance":{"amount":12345678901234567890.25,"currencyCode":"USD"}}',
        passJson: storeCard.files['pass.json'],
      },
    ],
  );
});

// A stream's loaded rows, with its declared fields only.
function streamRows(
  out: string,
  stream: {
    readonly name: string;
    readonly jsonSchema: { readonly properties?: object };
  },
  order: string,
) {
  const fields = Object.keys(stream.jsonSchema.properties ?? {})
    .map((field) => `"${field}"`)
    .join(', ');
  return rows(out, `SELECT ${fields} FROM ${stream.name} ORDER BY ${order}`);
}

// pass.json as an import keeps it: everything but the token.
function withoutToken(pass: ScratchPass): string {
  const json: unknown = JSON.parse(String(pass.files['pass.json']));
  assert.ok(typeof json === 'object' && json !== null);
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(json).filter(([key]) => key !== 'authenticationToken'),
    ),
  );
}

const sha1 = (content: string | Uint8Array | undefined) =>
  createHash('sha1')
    .update(content ?? '')
    .digest('hex');

// A field as passFields loads it when pass.json sets only what it names.
const field = (row: Record<string, unknown>) => ({
  label: null,
  attributedValue: null,
  changeMessage: null,
  textAlignment: null,
  dateStyle: null,
  timeStyle: null,
  ignoresTimeZone: 0,
  isRelative: 0,
  numberStyle: null,
  currencyCode: null,
  dataDetectorTypes: null,
  row: null,
  semantics: null,
  ...row,
});

test('every Wallet stream loads the store decoded, and a second run writes nothing', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'elt-wallet-'));
  walletFixture(dir.path);
  const source = new AppleWalletSource({ directory: dir.path });
  const run = await pipeline(source, dir.path);
  const out = join(dir.path, 'out.sqlite');
  const bundle = (pass: ScratchPass, path: string) =>
    join(dir.path, 'Cards', `${pass.id}.pkpass`, path);

  const first = counts(await run.run());

  assert.deepEqual(first, {
    passes: { count: 3, deleted: 0 },
    passFields: { count: 8, deleted: 0 },
    passBarcodes: { count: 3, deleted: 0 },
    passLocations: { count: 1, deleted: 0 },
    passBeacons: { count: 1, deleted: 0 },
    passRelevantDates: { count: 2, deleted: 0 },
    passLocalizations: { count: 4, deleted: 0 },
    passImages: { count: 5, deleted: 0 },
  });
  const unset = {
    logoText: null,
    transitType: null,
    groupingIdentifier: null,
    relevantAt: null,
    relevantAtOffset: null,
    expiresAt: null,
    expiresAtOffset: null,
    voided: 0,
    maxDistance: null,
    associatedStoreIdentifiers: null,
    appLaunchUrl: null,
    webServiceUrl: null,
    sharingProhibited: 0,
    foregroundColor: null,
    backgroundColor: null,
    labelColor: null,
    semantics: null,
    userInfo: null,
    personalization: null,
    formatVersion: 1,
  };
  assert.deepEqual(streamRows(out, source.passes, 'id'), [
    {
      ...unset,
      id: eventTicket.id,
      passTypeIdentifier: 'pass.com.example.venue',
      serialNumber: 'TICKET-1',
      teamIdentifier: 'TEAM654321',
      organizationName: 'Example Hall',
      description: 'Concert ticket',
      style: 'eventTicket',
      expiresAt: '2026-02-13T23:00:00.250Z',
      expiresAtOffset: 0,
      maxDistance: 120.5,
      addedAt: '2026-02-10T18:58:50.405923Z',
      updatedAt: '2026-02-10T18:58:50.447005Z',
      signedAt: '2026-02-10T18:52:01.000000Z',
      archivedAt: null,
      sortingState: null,
      passJson: withoutToken(eventTicket),
    },
    {
      ...unset,
      id: boardingPass.id,
      passTypeIdentifier: 'pass.com.example.airline',
      serialNumber: 'BP-845',
      teamIdentifier: 'TEAM123456',
      organizationName: 'Example Air',
      description: 'BOARDING_PASS',
      logoText: 'Example Air',
      style: 'boardingPass',
      transitType: 'PKTransitTypeAir',
      groupingIdentifier: 'BOOKING-9U5XWF',
      relevantAt: '2025-09-15T01:30:00.000Z',
      relevantAtOffset: 480,
      associatedStoreIdentifiers: '[581264644]',
      appLaunchUrl: 'exampleair://booking/9U5XWF',
      webServiceUrl: 'https://passes.example.com/v1',
      sharingProhibited: 1,
      foregroundColor: 'rgb(144,6,82)',
      backgroundColor: 'rgb(246,246,246)',
      labelColor: 'rgb(116,127,138)',
      semantics:
        '{"airlineCode":"EA","flightNumber":845,"departureAirportCode":"KUL","destinationAirportCode":"DOH"}',
      userInfo: '{"booking":"9U5XWF"}',
      addedAt: '2025-09-15T09:28:20.663083Z',
      updatedAt: '2025-09-15T09:28:20.977644Z',
      signedAt: '2025-09-14T22:07:46.000000Z',
      archivedAt: null,
      sortingState: 0,
      passJson: withoutToken(boardingPass),
    },
    {
      ...unset,
      id: storeCard.id,
      passTypeIdentifier: 'pass.com.example.cafe',
      serialNumber: 'CARD-1',
      teamIdentifier: 'TEAM777777',
      organizationName: 'Example Cafe',
      description: 'Rewards card',
      style: 'storeCard',
      semantics:
        '{"balance":{"amount":12345678901234567890.25,"currencyCode":"USD"}}',
      personalization: storeCard.files['personalization.json'],
      addedAt: '2026-03-01T08:00:00.000001Z',
      updatedAt: '2026-03-01T08:00:00.000002Z',
      signedAt: '2026-03-01T07:59:00.000000Z',
      archivedAt: null,
      sortingState: 0,
      passJson: storeCard.files['pass.json'],
    },
  ]);
  assert.deepEqual(
    streamRows(out, source.passFields, 'passId, area, position'),
    [
      field({
        passId: eventTicket.id,
        area: 'auxiliary',
        position: 0,
        key: 'seat',
        label: 'SEAT',
        value: 'A12',
        row: 1,
      }),
      field({
        passId: eventTicket.id,
        area: 'primary',
        position: 0,
        key: 'event',
        value: 'Night Concert',
      }),
      field({
        passId: boardingPass.id,
        area: 'auxiliary',
        position: 0,
        key: 'departure',
        label: 'DEPARTS',
        value: '2025-09-15T09:30+08:00',
        dateStyle: 'PKDateStyleMedium',
        timeStyle: 'PKDateStyleShort',
        ignoresTimeZone: 1,
        isRelative: 1,
        semantics: '{"originalDepartureDate":"2025-09-15T09:30+08:00"}',
      }),
      field({
        passId: boardingPass.id,
        area: 'back',
        position: 0,
        key: 'website',
        label: 'WEBSITE',
        value: 'https://example.com/9U5XWF',
        attributedValue: '<a href="https://example.com/9U5XWF">Manage</a>',
        dataDetectorTypes: '["PKDataDetectorTypeLink"]',
      }),
      field({
        passId: boardingPass.id,
        area: 'header',
        position: 0,
        key: 'boarding-gate',
        label: 'GATE',
        value: 'C1',
        textAlignment: 'PKTextAlignmentRight',
        changeMessage: 'Gate changed to %@',
      }),
      field({
        passId: boardingPass.id,
        area: 'primary',
        position: 0,
        key: 'origin',
        label: 'KUALA_LUMPUR',
        value: 'KUL',
      }),
      field({
        passId: boardingPass.id,
        area: 'primary',
        position: 1,
        key: 'destination',
        label: 'DOHA',
        value: 'DOH',
      }),
      field({
        passId: storeCard.id,
        area: 'primary',
        position: 0,
        key: 'balance',
        label: 'BALANCE',
        value: '12345678901234567890.25',
        numberStyle: 'PKNumberStyleDecimal',
        currencyCode: 'USD',
      }),
    ],
  );
  assert.deepEqual(streamRows(out, source.passBarcodes, 'passId, position'), [
    {
      passId: eventTicket.id,
      position: 0,
      format: 'PKBarcodeFormatAztec',
      message: 'TICKET-1-SEAT-A12',
      messageEncoding: 'utf-8',
      altText: null,
    },
    {
      passId: boardingPass.id,
      position: 0,
      format: 'PKBarcodeFormatQR',
      message: 'M1RIVERA/SAM E9U5XWF KULDOHEA 0845',
      messageEncoding: 'iso-8859-1',
      altText: '9U5XWF',
    },
    {
      passId: boardingPass.id,
      position: 1,
      format: 'PKBarcodeFormatPDF417',
      message: 'M1RIVERA/SAM E9U5XWF KULDOHEA 0845',
      messageEncoding: 'iso-8859-1',
      altText: null,
    },
  ]);
  assert.deepEqual(streamRows(out, source.passLocations, 'passId, position'), [
    {
      passId: eventTicket.id,
      position: 0,
      latitude: 25.195613989,
      longitude: 55.277543085,
      altitude: 12.5,
      relevantText: 'Doors open at 8',
    },
  ]);
  assert.deepEqual(streamRows(out, source.passBeacons, 'passId, position'), [
    {
      passId: eventTicket.id,
      position: 0,
      proximityUuid: 'E2C56DB5-DFFB-48D2-B060-D0F5A71096E0',
      major: 1,
      minor: 65535,
      relevantText: 'Welcome',
    },
  ]);
  assert.deepEqual(
    streamRows(out, source.passRelevantDates, 'passId, position'),
    [
      {
        passId: eventTicket.id,
        position: 0,
        at: null,
        atOffset: null,
        startsAt: '2026-02-13T16:00:00.000Z',
        startsAtOffset: 240,
        endsAt: '2026-02-13T19:00:00.000Z',
        endsAtOffset: 240,
      },
      {
        passId: eventTicket.id,
        position: 1,
        at: '2026-02-14T01:00:00.000Z',
        atOffset: -330,
        startsAt: null,
        startsAtOffset: null,
        endsAt: null,
        endsAtOffset: null,
      },
    ],
  );
  assert.deepEqual(
    streamRows(out, source.passLocalizations, 'passId, language, key'),
    [
      {
        passId: boardingPass.id,
        language: 'ar',
        key: 'BOARDING_PASS',
        text: 'بطاقة صعود',
      },
      {
        passId: boardingPass.id,
        language: 'ar',
        key: 'KUALA_LUMPUR',
        text: 'كوالالمبور',
      },
      {
        passId: boardingPass.id,
        language: 'en',
        key: 'BOARDING_PASS',
        text: 'Boarding pass',
      },
      {
        passId: boardingPass.id,
        language: 'en',
        key: 'KUALA_LUMPUR',
        text: 'Kuala Lumpur',
      },
    ],
  );
  assert.deepEqual(streamRows(out, source.passImages, 'passId, path'), [
    {
      passId: eventTicket.id,
      path: 'strip.png',
      name: 'strip',
      scale: 1,
      language: null,
      sha1: sha1(eventTicket.files['strip.png']),
      file: bundle(eventTicket, 'strip.png'),
    },
    {
      passId: boardingPass.id,
      path: 'ar.lproj/logo.png',
      name: 'logo',
      scale: 1,
      language: 'ar',
      sha1: sha1(boardingPass.files['ar.lproj/logo.png']),
      file: bundle(boardingPass, 'ar.lproj/logo.png'),
    },
    {
      passId: boardingPass.id,
      path: 'icon.png',
      name: 'icon',
      scale: 1,
      language: null,
      sha1: sha1(boardingPass.files['icon.png']),
      file: bundle(boardingPass, 'icon.png'),
    },
    {
      passId: boardingPass.id,
      path: 'icon@2x.png',
      name: 'icon',
      scale: 2,
      language: null,
      sha1: sha1(boardingPass.files['icon@2x.png']),
      file: bundle(boardingPass, 'icon@2x.png'),
    },
    {
      passId: storeCard.id,
      path: 'thumbnail.png',
      name: 'thumbnail',
      scale: 1,
      language: null,
      sha1: sha1(storeCard.files['thumbnail.png']),
      file: bundle(storeCard, 'thumbnail.png'),
    },
  ]);

  assert.deepEqual(
    counts(await run.run()),
    Object.fromEntries(
      streamNames.map((name) => [name, { count: 0, deleted: 0 }]),
    ),
  );
});

// A pass's pass.json with some keys replaced, as an issuer's new version or
// an older pass writes it.
function edited(pass: ScratchPass, keys: Record<string, unknown>): string {
  const json: unknown = JSON.parse(String(pass.files['pass.json']));
  assert.ok(typeof json === 'object' && json !== null);
  return JSON.stringify(
    Object.fromEntries(
      Object.entries({ ...json, ...keys }).filter(
        ([, value]) => value !== undefined,
      ),
    ),
  );
}

test('an expired, voided or archived pass stays loaded with what flags it', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'elt-wallet-'));
  {
    using wallet = new ScratchWallet(dir.path);
    wallet.add(storeCard);
    // A ticket that expired and was used, which Wallet archived as it added
    // it, as it does a pass already past.
    wallet.add({
      ...eventTicket,
      annotation: {
        sortingState: 1,
        archivedAt: appleTime('2026-02-10T18:58:50Z', 829152),
      },
      files: {
        ...eventTicket.files,
        'pass.json': edited(eventTicket, { voided: true }),
      },
    });
  }
  const source = new AppleWalletSource({ directory: dir.path });
  const run = await pipeline(source, dir.path);

  await run.run();

  assert.deepEqual(
    rows(
      join(dir.path, 'out.sqlite'),
      'SELECT id, expiresAt, voided, archivedAt, sortingState FROM passes ORDER BY id',
    ),
    [
      {
        id: eventTicket.id,
        expiresAt: '2026-02-13T23:00:00.250Z',
        voided: 1,
        archivedAt: '2026-02-10T18:58:50.829152Z',
        sortingState: 1,
      },
      {
        id: storeCard.id,
        expiresAt: null,
        voided: 0,
        archivedAt: null,
        sortingState: 0,
      },
    ],
  );
});

test('a pass that repeats a field key, a barcode or a location loads every one of them', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'elt-wallet-'));
  const gate = { key: 'gate', label: 'GATE', value: 'C1' };
  const barcode = {
    format: 'PKBarcodeFormatQR',
    message: 'SAME',
    messageEncoding: 'iso-8859-1',
  };
  const place = { latitude: 1.5, longitude: 2.5 };
  {
    using wallet = new ScratchWallet(dir.path);
    wallet.add({
      ...eventTicket,
      files: {
        'pass.json': edited(eventTicket, {
          barcodes: [barcode, barcode],
          locations: [place, place],
          beacons: undefined,
          relevantDates: undefined,
          eventTicket: { headerFields: [gate], backFields: [gate, gate] },
        }),
      },
    });
  }
  const run = await pipeline(
    new AppleWalletSource({ directory: dir.path }),
    dir.path,
  );
  const out = join(dir.path, 'out.sqlite');

  await run.run();

  assert.deepEqual(
    rows(
      out,
      'SELECT area, position, key FROM passFields ORDER BY area, position',
    ),
    [
      { area: 'back', position: 0, key: 'gate' },
      { area: 'back', position: 1, key: 'gate' },
      { area: 'header', position: 0, key: 'gate' },
    ],
  );
  assert.deepEqual(tableSizes(out), {
    passes: 1,
    passFields: 3,
    passBarcodes: 2,
    passLocations: 2,
    passBeacons: 0,
    passRelevantDates: 0,
    passLocalizations: 0,
    passImages: 0,
  });
});

test('a pass removed from Wallet deletes its rows from every stream, and the other passes stay', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'elt-wallet-'));
  walletFixture(dir.path);
  const run = await pipeline(
    new AppleWalletSource({ directory: dir.path }),
    dir.path,
  );
  const out = join(dir.path, 'out.sqlite');
  await run.run();
  {
    using passd = new ScratchWallet(dir.path, { existing: true });
    passd.remove(boardingPass);
  }

  const second = counts(await run.run());

  assert.deepEqual(second, {
    passes: { count: 0, deleted: 1 },
    passFields: { count: 0, deleted: 5 },
    passBarcodes: { count: 0, deleted: 2 },
    passLocations: { count: 0, deleted: 0 },
    passBeacons: { count: 0, deleted: 0 },
    passRelevantDates: { count: 0, deleted: 0 },
    passLocalizations: { count: 0, deleted: 4 },
    passImages: { count: 0, deleted: 3 },
  });
  for (const name of streamNames)
    assert.deepEqual(
      rows(
        out,
        `SELECT DISTINCT ${name === 'passes' ? 'id' : 'passId'} AS pass FROM ${name} ORDER BY pass`,
      ).map(({ pass }) => pass),
      {
        passes: [eventTicket.id, storeCard.id],
        passFields: [eventTicket.id, storeCard.id],
        passBarcodes: [eventTicket.id],
        passLocations: [eventTicket.id],
        passBeacons: [eventTicket.id],
        passRelevantDates: [eventTicket.id],
        passLocalizations: [],
        passImages: [eventTicket.id, storeCard.id],
      }[name],
      name,
    );
});

test('a new version of a pass changes its rows in place and deletes what it no longer holds', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'elt-wallet-'));
  walletFixture(dir.path);
  const run = await pipeline(
    new AppleWalletSource({ directory: dir.path }),
    dir.path,
  );
  const out = join(dir.path, 'out.sqlite');
  await run.run();
  // The venue moved the seat and dropped the beacon and the second relevant
  // date.
  {
    using passd = new ScratchWallet(dir.path, { existing: true });
    passd.update({
      ...eventTicket,
      updatedAt: appleTime('2026-02-12T09:00:00Z', 5),
      signedAt: appleTime('2026-02-12T08:59:00Z'),
      files: {
        ...eventTicket.files,
        'pass.json': edited(eventTicket, {
          beacons: undefined,
          relevantDates: [{ date: '2026-02-13T19:30-05:30' }],
          eventTicket: {
            primaryFields: [{ key: 'event', value: 'Night Concert' }],
            auxiliaryFields: [
              { key: 'seat', label: 'SEAT', value: 'B7', row: 1 },
            ],
          },
        }),
      },
    });
  }

  const second = counts(await run.run());

  assert.deepEqual(second, {
    passes: { count: 1, deleted: 0 },
    passFields: { count: 1, deleted: 0 },
    passBarcodes: { count: 0, deleted: 0 },
    passLocations: { count: 0, deleted: 0 },
    passBeacons: { count: 0, deleted: 1 },
    passRelevantDates: { count: 1, deleted: 1 },
    passLocalizations: { count: 0, deleted: 0 },
    passImages: { count: 0, deleted: 0 },
  });
  assert.deepEqual(
    rows(
      out,
      `SELECT updatedAt, signedAt FROM passes WHERE id = '${eventTicket.id}'`,
    ),
    [
      {
        updatedAt: '2026-02-12T09:00:00.000005Z',
        signedAt: '2026-02-12T08:59:00.000000Z',
      },
    ],
  );
  assert.deepEqual(
    rows(
      out,
      `SELECT key, value FROM passFields WHERE passId = '${eventTicket.id}' ORDER BY area`,
    ),
    [
      { key: 'seat', value: 'B7' },
      { key: 'event', value: 'Night Concert' },
    ],
  );
  assert.deepEqual(
    rows(
      out,
      `SELECT position, at FROM passRelevantDates WHERE passId = '${eventTicket.id}'`,
    ),
    [{ position: 0, at: '2026-02-14T01:00:00.000Z' }],
  );
});

test('a pass made before iOS 9 loads its one barcode, which a pass with a barcode list leaves out', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'elt-wallet-'));
  {
    using wallet = new ScratchWallet(dir.path);
    wallet.add(boardingPass);
    wallet.add({
      ...storeCard,
      files: {
        ...storeCard.files,
        'pass.json': edited(storeCard, {
          barcode: {
            format: 'PKBarcodeFormatPDF417',
            message: 'CARD-1',
            messageEncoding: 'iso-8859-1',
            altText: '1234',
          },
        }),
      },
    });
  }
  const run = await pipeline(
    new AppleWalletSource({ directory: dir.path }),
    dir.path,
  );

  await run.run();

  assert.deepEqual(
    rows(
      join(dir.path, 'out.sqlite'),
      'SELECT passId, position, format, message, altText FROM passBarcodes ORDER BY passId, position',
    ),
    [
      {
        passId: boardingPass.id,
        position: 0,
        format: 'PKBarcodeFormatQR',
        message: 'M1RIVERA/SAM E9U5XWF KULDOHEA 0845',
        altText: '9U5XWF',
      },
      {
        passId: boardingPass.id,
        position: 1,
        format: 'PKBarcodeFormatPDF417',
        message: 'M1RIVERA/SAM E9U5XWF KULDOHEA 0845',
        altText: null,
      },
      {
        passId: storeCard.id,
        position: 0,
        format: 'PKBarcodeFormatPDF417',
        message: 'CARD-1',
        altText: '1234',
      },
    ],
  );
});

test('each image loads with its file, and an image the issuer replaces loads again', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'elt-wallet-'));
  walletFixture(dir.path);
  const run = await pipeline(
    new AppleWalletSource({ directory: dir.path }),
    dir.path,
  );
  const out = join(dir.path, 'out.sqlite');
  const exported = async () =>
    Object.fromEntries(
      await Promise.all(
        rows(out, 'SELECT passId, path, attachmentRef FROM passImages').map(
          async ({ passId, path, attachmentRef }) => {
            assert.equal(
              typeof attachmentRef,
              'string',
              `${String(path)} exported no file`,
            );
            return [
              `${String(passId)}/${String(path)}`,
              await readFile(String(attachmentRef)),
            ];
          },
        ),
      ),
    );
  await run.run();
  assert.deepEqual(await exported(), {
    [`${eventTicket.id}/strip.png`]: redPixel,
    [`${boardingPass.id}/ar.lproj/logo.png`]: redPixel,
    [`${boardingPass.id}/icon.png`]: redPixel,
    [`${boardingPass.id}/icon@2x.png`]: bluePixel,
    [`${storeCard.id}/thumbnail.png`]: bluePixel,
  });
  {
    using passd = new ScratchWallet(dir.path, { existing: true });
    passd.update({
      ...storeCard,
      files: { ...storeCard.files, 'thumbnail.png': redPixel },
    });
  }

  const second = counts(await run.run());

  assert.deepEqual(second.passImages, { count: 1, deleted: 0 });
  assert.deepEqual(
    (await exported())[`${storeCard.id}/thumbnail.png`],
    redPixel,
  );
});

// The test's own timeout fails a watch that outlives its abort: the
// pipeline waits on the source's observe, so a signal the source ignores ends
// nothing.
test(
  'a Wallet watch loads each commit while passd keeps its store open, and stops when aborted',
  { timeout: 15_000 },
  async () => {
    await using dir = await mkdtempDisposable(join(tmpdir(), 'elt-wallet-'));
    {
      using wallet = new ScratchWallet(dir.path);
      wallet.add(storeCard);
    }
    const run = await pipeline(
      new AppleWalletSource({ directory: dir.path }),
      dir.path,
    );
    // passd holds its connection open the whole time.
    using passd = new ScratchWallet(dir.path, { existing: true });
    passd.exec('CREATE TABLE cloud_store_zone (pid INTEGER, zone_name TEXT)');
    const controller = new AbortController();
    const batches: Record<string, { count: number; deleted: number }>[] = [];
    let abortedAt = Number.NaN;

    for await (const { outcomes } of run.watch({
      // A batch that never comes ends the watch, so the assertion fails.
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
    })) {
      batches.push(counts(outcomes));
      if (batches.length === 1) passd.add(eventTicket);
      // CloudKit bookkeeping commits without changing a pass.
      else if (batches.length === 2)
        passd.exec("INSERT INTO cloud_store_zone VALUES (1, 'passes')");
      // Past the next one-second poll, so a spurious batch would show.
      else
        setTimeout(() => {
          abortedAt = performance.now();
          controller.abort();
        }, 1500);
    }

    // The abort ended the watch, not the timeout that guards a hang.
    assert.ok(performance.now() - abortedAt < 1000);

    const none = { count: 0, deleted: 0 };
    assert.deepEqual(batches, [
      {
        passes: { count: 1, deleted: 0 },
        passFields: { count: 1, deleted: 0 },
        passBarcodes: none,
        passLocations: none,
        passBeacons: none,
        passRelevantDates: none,
        passLocalizations: none,
        passImages: { count: 1, deleted: 0 },
      },
      {
        passes: { count: 1, deleted: 0 },
        passFields: { count: 2, deleted: 0 },
        passBarcodes: { count: 1, deleted: 0 },
        passLocations: { count: 1, deleted: 0 },
        passBeacons: { count: 1, deleted: 0 },
        passRelevantDates: { count: 2, deleted: 0 },
        passLocalizations: none,
        passImages: { count: 1, deleted: 0 },
      },
      Object.fromEntries(streamNames.map((name) => [name, none])),
    ]);
  },
);

test('this Mac’s Wallet loads every pass passd lists, as passd records it, and a second run writes nothing', async (t) => {
  if (process.platform !== 'darwin') return t.skip('Wallet requires macOS');
  await using dir = await mkdtempDisposable(join(tmpdir(), 'elt-wallet-live-'));
  const out = join(dir.path, 'out.sqlite');
  const run = await pipeline(new AppleWalletSource(), dir.path);

  try {
    await run.run();
  } catch (error) {
    if (
      error instanceof PipelineError &&
      error.errors.every((cause) => cause instanceof WalletUnavailableError)
    )
      return t.skip('this Mac has no Wallet store');
    throw error;
  }

  // Compared, never printed: these are the user's own passes. passd keeps
  // its own copy of each pass's serial number, expiry and places, decoded
  // when it added the pass, so the reader's decoding of pass.json must agree.
  const stored = rows(
    join(walletStorePath, 'passes23.sqlite'),
    `SELECT pass.unique_id AS id, pass.serial_number AS serialNumber,
            pass.expiration_date AS expiration,
            (SELECT count(*) FROM pass_location_source AS source
             JOIN location ON location.location_source_pid = source.location_source_pid
             WHERE source.pass_pid = pass.pid) AS locations
     FROM pass ORDER BY pass.unique_id`,
  );
  if (stored.length === 0) return t.skip('Wallet on this Mac holds no pass');
  const loadedPasses = new Map(
    rows(
      out,
      `SELECT id, serialNumber, expiresAt AS expiration,
              (SELECT count(*) FROM passLocations WHERE passId = passes.id) AS locations
       FROM passes`,
    ).map((pass) => [pass.id, pass]),
  );
  // Counted, so a failure names no pass.
  const differing = stored.filter(
    ({ id, serialNumber, expiration, locations }) => {
      const pass = loadedPasses.get(id);
      return (
        pass === undefined ||
        pass.serialNumber !== serialNumber ||
        pass.expiration !==
          (expiration === null
            ? null
            : new Date(
                (Number(expiration) + 978307200) * 1000,
              ).toISOString()) ||
        pass.locations !== locations
      );
    },
  ).length;
  assert.equal(loadedPasses.size, stored.length);
  assert.equal(
    differing,
    0,
    'passes whose serial number, expiry or places differ from passd’s record',
  );
  // Every pass loads its pass.json whole, without its token, and every image
  // its manifest lists.
  const loaded = (sql: string) => Number(rows(out, sql)[0]?.n);
  assert.equal(
    loaded(
      "SELECT count(*) AS n FROM passes WHERE json_valid(passJson) = 0 OR json_type(passJson, '$.authenticationToken') IS NOT NULL",
    ),
    0,
  );
  const images = (
    await Promise.all(
      stored.map(async ({ id }) => {
        const manifest: unknown = JSON.parse(
          await readFile(
            join(
              walletStorePath,
              'Cards',
              `${String(id)}.pkpass`,
              'manifest.json',
            ),
            'utf8',
          ),
        );
        assert.ok(typeof manifest === 'object' && manifest !== null);
        return Object.keys(manifest).filter((path) => /\.png$/i.test(path))
          .length;
      }),
    )
  ).reduce((sum, count) => sum + count, 0);
  assert.equal(loaded('SELECT count(*) AS n FROM passImages'), images);

  assert.deepEqual(
    counts(await run.run()),
    Object.fromEntries(
      streamNames.map((name) => [name, { count: 0, deleted: 0 }]),
    ),
  );
});
