import { createHash, hash, randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

import { TemporaryFiles } from '@zukhruf/fs';

import type { FileContent } from '../core/file-content.ts';
import { fileExtension } from '../core/file-extension.ts';
import { FileStorage, StoredFileMissingError } from '../core/file-storage.ts';

// The most bytes of one chunk of a stored file, as LocalFiles streams a file:
// no file is held in memory whole, and no value of a database is near its
// largest.
const storedChunkSize = 4 * 1024 * 1024;

// A file storage that keeps each file in a table of the database of a
// destination, as ordered chunks of at most storedChunkSize bytes. A row of
// the table is a scope (the SHA-256 of the scope), a name (the SHA-256 of the
// bytes and the short source extension, as LocalFiles names its files), the
// place of the chunk from 0, and its bytes. An empty file is one empty chunk.
// A ref is `<scope hash>/<name>`, which names no server, so a warehouse that
// moves keeps its refs.
//
// This class owns the steps that each database shares; a subclass gives its
// connection and its SQL. Each operation uses a connection of its own, not the
// connection of a load, and each statement commits on its own: files and rows
// do not share a transaction, so a save is durable when it resolves, before
// the rows that name it commit.
export abstract class DatabaseFiles<
  Connection extends AsyncDisposable | Disposable,
> extends FileStorage {
  override readonly reference: string;
  readonly #table: string;

  // table: the table as readers of the database name it.
  constructor(table: string) {
    super();
    this.#table = table;
    this.reference = `Name of a copy of the source file bytes in table ${table} of this database: the SHA-256 of its scope, a slash, and the SHA-256 of the bytes with a short source extension. Kept only while a row references it. Not the source file name, a URL or extracted text.`;
  }

  // A connection of the storage's own, with its table made when absent.
  protected abstract connect(): Promise<Connection>;

  // Inserts chunk n of the file name of scope.
  protected abstract write(
    connection: Connection,
    scope: string,
    name: string,
    n: number,
    bytes: Uint8Array,
  ): Promise<void>;

  // Renames each chunk of from to to when scope has no file to, in one
  // statement.
  protected abstract rename(
    connection: Connection,
    scope: string,
    from: string,
    to: string,
  ): Promise<void>;

  protected abstract remove(
    connection: Connection,
    scope: string,
    names: readonly string[],
  ): Promise<void>;

  // The name of each file of scope: the files whose chunk 0 is stored.
  protected abstract names(
    connection: Connection,
    scope: string,
  ): Promise<readonly string[]>;

  // The first length bytes of chunk n of the file name of scope, or undefined
  // when that chunk is not stored.
  protected abstract read(
    connection: Connection,
    scope: string,
    name: string,
    n: number,
    length: number,
  ): Promise<Uint8Array | undefined>;

  // The chunks go under a pending name until the hash of all of them names
  // the file, as LocalFiles links a temporary file. The rename publishes them
  // only when the scope has no file of that name, so a save again never
  // overwrites a file, and the pending chunks then go. Pending chunks that a
  // failed save leaves are not referenced, so the next retain removes them.
  override async save(scope: string, content: FileContent): Promise<string> {
    const key = hash('sha256', scope);
    const pending = `.pending-${randomUUID()}`;
    await using connection = await this.connect();
    const sha256 = createHash('sha256');
    let n = 0;
    for await (const chunk of content.chunks(storedChunkSize)) {
      sha256.update(chunk);
      await this.write(connection, key, pending, n++, chunk);
    }
    if (n === 0)
      await this.write(connection, key, pending, 0, new Uint8Array());
    const name = sha256.digest('hex') + fileExtension(content.path);
    await this.rename(connection, key, pending, name);
    await this.remove(connection, key, [pending]);
    return `${key}/${name}`;
  }

  // Each save committed its chunks before it resolved.
  override async flush(): Promise<void> {}

  override async retain(
    scope: string,
    references: ReadonlySet<string>,
  ): Promise<void> {
    const key = hash('sha256', scope);
    await using connection = await this.connect();
    const missing = new Set(references);
    const obsolete: string[] = [];
    for (const name of await this.names(connection, key))
      if (!missing.delete(`${key}/${name}`)) obsolete.push(name);
    if (missing.size > 0)
      throw new Error(
        `Stored attachment is missing or outside its scope: ${[...missing][0]}`,
      );
    if (obsolete.length > 0) await this.remove(connection, key, obsolete);
  }

  // A temporary copy in a folder of its own (owner-only), named as the file
  // is stored, so the parser sees the source's extension. The dispose
  // removes the folder.
  override async open(
    ref: string,
    signal?: AbortSignal,
  ): Promise<{ readonly path: string } & AsyncDisposable> {
    const [key, name] = this.#parse(ref);
    await using connection = await this.connect();
    let chunk = await this.read(connection, key, name, 0, storedChunkSize);
    if (chunk === undefined) throw this.#missing(ref);
    const folder = await new TemporaryFiles().directory('elt-file-');
    try {
      const path = join(folder.path, name);
      await using file = await open(path, 'wx', 0o600);
      for (let n = 1; chunk !== undefined; n++) {
        await file.writeFile(chunk);
        signal?.throwIfAborted();
        chunk = await this.read(connection, key, name, n, storedChunkSize);
      }
      return { path, [Symbol.asyncDispose]: folder.cleanup };
    } catch (error) {
      await folder.cleanup();
      throw error;
    }
  }

  // Reads only the chunks that hold the first length bytes, and of those
  // only the bytes it needs.
  override async head(
    ref: string,
    length: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const [key, name] = this.#parse(ref);
    await using connection = await this.connect();
    const parts: Uint8Array[] = [];
    let wanted = length;
    for (let n = 0; ; n++) {
      signal?.throwIfAborted();
      const chunk = await this.read(connection, key, name, n, wanted);
      if (chunk === undefined) {
        if (n === 0) throw this.#missing(ref);
        break;
      }
      parts.push(chunk);
      wanted -= chunk.length;
      if (wanted <= 0) break;
    }
    return Buffer.concat(parts);
  }

  // The scope and the name of a ref. A ref of another form names no file of
  // this storage.
  #parse(ref: string): readonly [string, string] {
    const [, key, name] = /^([0-9a-f]{64})\/([^/]+)$/.exec(ref) ?? [];
    if (key === undefined || name === undefined) throw this.#missing(ref);
    return [key, name];
  }

  #missing(ref: string): StoredFileMissingError {
    return new StoredFileMissingError(
      `Table ${this.#table} has no stored file ${ref}. Reload the copy that stored it to store the file again.`,
    );
  }
}
