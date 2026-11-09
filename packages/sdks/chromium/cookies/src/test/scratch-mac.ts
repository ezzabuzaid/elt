import { execFileSync } from 'node:child_process';
import { createCipheriv, hash, pbkdf2Sync } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RollbackJournal, open } from '@zukhruf/sqlite-open';

export type ScratchCookie = {
  readonly host: string;
  readonly name: string;
  readonly value: string;
  // Days from the now that the profile is written at, a negative number
  // having expired; null for a session cookie, which has no expiry.
  readonly days: number | null;
  // The host whose SHA-256 leads the plaintext: the cookie's own host,
  // unless a test signs it for another.
  readonly signedFor?: string;
};

const security = (...args: string[]) =>
  execFileSync('/usr/bin/security', args, { stdio: 'pipe' });

// Microseconds since 1601-01-01, the clock Chromium stores times on, days
// after now.
function chromiumTime(now: Date, days: number): number {
  return (now.getTime() + days * 86_400_000) * 1000 + 11_644_473_600_000_000;
}

// A Mac home for a test, in place of the user's: a temporary folder that
// holds a login keychain of its own and the cookie stores of the browser
// profiles the test writes; the test gives path as the home. The user's
// browsers and keychain hold real sessions a test must not read, so a test
// reads these instead, through the same /usr/bin/security and SQLite reads
// as on the user's Mac.
export class ScratchMac implements AsyncDisposable {
  readonly path: string;
  readonly #keychain: string;

  private constructor(path: string, keychain: string) {
    this.path = path;
    this.#keychain = keychain;
  }

  static async create(): Promise<ScratchMac> {
    const path = await mkdtemp(join(tmpdir(), 'scratch-mac-'));
    const keychain = join(path, 'Library/Keychains/login.keychain-db');
    mkdirSync(join(path, 'Library/Keychains'), { recursive: true });
    security('create-keychain', '-p', 'scratch', keychain);
    return new ScratchMac(path, keychain);
  }

  // The Safe Storage password a Chromium browser keeps in the login keychain,
  // readable without a prompt.
  safeStorage(service: string, account: string, password: string): void {
    security(
      'add-generic-password',
      '-a',
      account,
      '-s',
      service,
      '-w',
      password,
      '-A',
      this.#keychain,
    );
  }

  // A browser profile's Cookies database, as Chromium writes it at meta
  // version 24: each value v10-encrypted with the key derived from password,
  // behind the SHA-256 of its host. profile is the folder under Application
  // Support, such as Dia/User Data/Default. Each cookie is created at now,
  // and expires its days after it.
  cookies(
    profile: string,
    password: string,
    cookies: readonly ScratchCookie[],
    now: Date,
  ): void {
    const folder = join(this.path, 'Library/Application Support', profile);
    mkdirSync(folder, { recursive: true });
    using database = open(join(folder, 'Cookies'), {
      journal: new RollbackJournal(),
    });
    database.exec(`
      CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
      CREATE TABLE cookies(creation_utc INTEGER NOT NULL,host_key TEXT NOT NULL,top_frame_site_key TEXT NOT NULL,name TEXT NOT NULL,value TEXT NOT NULL,encrypted_value BLOB NOT NULL,path TEXT NOT NULL,expires_utc INTEGER NOT NULL,is_secure INTEGER NOT NULL,is_httponly INTEGER NOT NULL,last_access_utc INTEGER NOT NULL,has_expires INTEGER NOT NULL,is_persistent INTEGER NOT NULL,priority INTEGER NOT NULL,samesite INTEGER NOT NULL,source_scheme INTEGER NOT NULL,source_port INTEGER NOT NULL,last_update_utc INTEGER NOT NULL,source_type INTEGER NOT NULL,has_cross_site_ancestor INTEGER NOT NULL);
      INSERT INTO meta VALUES ('version', '24');
    `);
    const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
    const insert = database.prepare(
      `INSERT INTO cookies VALUES (?, ?, '', ?, '', ?, '/', ?, 1, 1, ?, ?, 1, 1, 0, 2, 443, ?, 0, 0)`,
    );
    for (const { host, name, value, days, signedFor = host } of cookies) {
      const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 32));
      const plain = Buffer.concat([
        hash('sha256', signedFor, 'buffer'),
        Buffer.from(value),
      ]);
      insert.run(
        chromiumTime(now, 0),
        host,
        name,
        Buffer.concat([
          Buffer.from('v10'),
          cipher.update(plain),
          cipher.final(),
        ]),
        days === null ? 0 : chromiumTime(now, days),
        chromiumTime(now, 0),
        days === null ? 0 : 1,
        chromiumTime(now, 0),
      );
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    security('delete-keychain', this.#keychain);
    await rm(this.path, { recursive: true, force: true });
  }
}
