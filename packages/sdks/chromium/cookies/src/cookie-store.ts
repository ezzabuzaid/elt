import { createDecipheriv, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { CookieDecryptionError } from './errors.ts';

// Chromium counts microseconds from 1601-01-01.
const epochOffset = 11_644_473_600_000_000n;

// One profile's Cookies database, opened read-only through SQLite's own
// locks: the browser keeps it in rollback-journal mode and never holds it
// exclusively, so a read waits out a write instead of seeing half of it.
export class CookieStore implements Disposable {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    this.#database = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
  }

  // When the named cookie that url is sent with expires, in Chromium's
  // microseconds; null when the profile has none that is still valid.
  expiry(url: URL, name: string): bigint | null {
    const hosts = hostKeys(url);
    const statement = this.#database.prepare(
      `SELECT max(expires_utc) AS expires FROM cookies
       WHERE name = ? AND host_key IN (${hosts.map(() => '?').join(', ')})
         AND (has_expires = 0 OR expires_utc > ?)`,
    );
    statement.setReadBigInts(true);
    const row = statement.get(name, ...hosts, now());
    return typeof row?.expires === 'bigint' ? row.expires : null;
  }

  // The cookies the browser sends with a request to url, by name; a cookie
  // set for the exact host overrides one set for its domain.
  cookies(url: URL, key: Buffer, browser: string): Map<string, string> {
    const version = Number(
      this.#database
        .prepare(`SELECT value FROM meta WHERE key = 'version'`)
        .get()?.value,
    );
    if (!(version >= 24))
      throw new TypeError(
        `${browser}'s cookie store is version ${version}; this package reads version 24 and later`,
      );
    const hosts = hostKeys(url);
    const rows = this.#database
      .prepare(
        `SELECT host_key, name, encrypted_value FROM cookies
         WHERE host_key IN (${hosts.map(() => '?').join(', ')})
           AND (has_expires = 0 OR expires_utc > ?)
         ORDER BY length(host_key), host_key`,
      )
      .all(...hosts, now());
    const cookies = new Map<string, string>();
    for (const row of rows) {
      const host = String(row.host_key);
      const name = String(row.name);
      cookies.set(
        name,
        decrypt(row.encrypted_value, key, { browser, host, name }),
      );
    }
    return cookies;
  }

  [Symbol.dispose](): void {
    this.#database.close();
  }
}

// The host keys whose cookies a request to url carries: the host itself, and
// the domain cookies of the host and of each parent domain.
function hostKeys(url: URL): string[] {
  const labels = url.hostname.split('.');
  const parents = labels
    .slice(0, -1)
    .map((_, index) => `.${labels.slice(index).join('.')}`);
  return [url.hostname, ...parents];
}

function now(): bigint {
  return BigInt(Date.now()) * 1000n + epochOffset;
}

// A v10 value is AES-128-CBC with a fixed IV of spaces, and its plaintext
// starts with the SHA-256 of its host, which tells a wrong key from a right
// one.
function decrypt(
  encrypted: unknown,
  key: Buffer,
  cookie: { browser: string; host: string; name: string },
): string {
  const failed = (cause?: unknown) =>
    new CookieDecryptionError(cookie.browser, cookie.host, cookie.name, {
      cause,
    });
  if (!(encrypted instanceof Uint8Array)) throw failed();
  const blob = Buffer.from(encrypted);
  if (blob.subarray(0, 3).toString('latin1') !== 'v10') throw failed();
  let value: Buffer;
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 32));
    value = Buffer.concat([
      decipher.update(blob.subarray(3)),
      decipher.final(),
    ]);
  } catch (cause) {
    throw failed(cause);
  }
  const digest = createHash('sha256').update(cookie.host).digest();
  if (!value.subarray(0, 32).equals(digest)) throw failed();
  return value.subarray(32).toString('utf8');
}
