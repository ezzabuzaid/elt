import { lstat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { Declaration } from '@zukhruf/sqlite-drift';

import type { DocumentParser } from '@workspace/elt';
import { publishSQLiteViews } from '@workspace/elt-sqlite';

// Vision text recognition, the slowest format, read about three times as
// many files a second with four at once and little more with eight.
const concurrency = 4;

// A table another version declared otherwise is replaced, and every stored
// file is read again.
const rawAttachmentText = new Declaration([
  `CREATE TABLE raw_attachment_text (ref TEXT PRIMARY KEY, sha256 TEXT NOT NULL, parser TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('parsed', 'no_text', 'failed')), content TEXT, error TEXT)`,
]);

const columns = {
  ref: 'Absolute path of the stored copy: the attachmentRef value of every row whose file it is. Join attachmentRef to it.',
  sha256:
    'SHA-256 of the file bytes, which also names the stored copy. Rows of different tables that hold the same file share it.',
  parser:
    'Identity of the parser that read the file, such as macos-document-v4. A file read by an earlier version is read again.',
  status:
    'parsed: content holds the text. no_text: the parser read the file and found no text it can represent, such as a photo without words or a voice message. failed: reading the file failed and error says why; the file is read again after the next sync.',
  content: 'The text the parser extracted. NULL unless status is parsed.',
  error: 'Why reading the file failed. NULL unless status is failed.',
};

// The text of the files an import stored, so readers can search them with
// SQL. It is auxiliary to the import, not part of it: AppleConnector updates
// it after each pass the import commits, and no host shows that as a pass.
// The files the import's rows reference are its work queue: each update
// reads the ones this parser has not read or failed to read, several at once,
// and forgets the ones no row references any longer.
export class AttachmentText {
  readonly #path: string;
  readonly #views: readonly string[];
  readonly #parser: DocumentParser;

  // views: the import's reader views whose rows carry an attachmentRef.
  constructor(path: string, views: readonly string[], parser: DocumentParser) {
    this.#path = path;
    this.#views = views;
    this.#parser = parser;
  }

  // Each read commits on its own, so readers see text as it lands and an
  // update stopped partway keeps what it read; signal stops it taking more.
  async update(signal: AbortSignal): Promise<void> {
    using database = new DatabaseSync(this.#path, { timeout: 30_000 });
    const due = this.#reconcile(database);
    const failures: unknown[] = [];
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(concurrency, due.length) }, async () => {
        while (failures.length === 0 && !signal.aborted) {
          const ref = due[next++];
          if (ref === undefined) return;
          await this.#read(database, ref).catch((error: unknown) => {
            failures.push(error);
          });
        }
      }),
    );
    if (failures.length > 0) throw failures[0];
  }

  // Publishes the table and its view, forgets the files no row references,
  // and returns those still to read.
  #reconcile(database: DatabaseSync): string[] {
    database.exec('BEGIN IMMEDIATE');
    try {
      rawAttachmentText.apply(database);
      publishSQLiteViews(database, {
        views: [
          {
            name: 'attachment_text',
            description:
              'One row per file this import stored, with the text its parser extracted, read after each sync. A stored file not read yet has no row, so search results are complete only once the text caught up with the sync. Primary key ref.',
            columns,
            query: `SELECT ${Object.keys(columns).join(', ')} FROM raw_attachment_text`,
          },
        ],
      });
      const present = new Set(
        database
          .prepare(
            `SELECT name FROM sqlite_schema WHERE type = 'view' AND name IN (${this.#views.map(() => '?').join(', ')})`,
          )
          .all(...this.#views)
          .map(({ name }) => String(name)),
      );
      const referenced =
        this.#views
          .filter((view) => present.has(view))
          .map(
            (view) =>
              `SELECT DISTINCT attachmentRef AS ref FROM "${view}" WHERE attachmentRef IS NOT NULL`,
          )
          .join(' UNION ') || 'SELECT NULL AS ref WHERE 0';
      database.exec(
        `DELETE FROM raw_attachment_text WHERE ref NOT IN (${referenced})`,
      );
      const due = database
        .prepare(
          `SELECT r.ref FROM (${referenced}) r LEFT JOIN raw_attachment_text t ON t.ref = r.ref
           WHERE t.ref IS NULL OR t.parser <> ? OR t.status = 'failed' ORDER BY r.ref`,
        )
        .all(this.#parser.identity)
        .map(({ ref }) => String(ref));
      database.exec('COMMIT');
      return due;
    } catch (error) {
      if (database.isTransaction) database.exec('ROLLBACK');
      throw error;
    }
  }

  async #read(database: DatabaseSync, ref: string): Promise<void> {
    let status: 'parsed' | 'no_text' | 'failed';
    let content: string | null = null;
    let error: string | null = null;
    try {
      content = await this.#parser.parse(ref);
      status = content === null ? 'no_text' : 'parsed';
    } catch (failure) {
      // A commit removed the copy after the update listed it; its rows are
      // gone too, so the file is not a failure.
      if (await removed(ref)) return;
      status = 'failed';
      error = failure instanceof Error ? failure.message : String(failure);
    }
    database
      .prepare(
        `INSERT INTO raw_attachment_text (ref, sha256, parser, status, content, error) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (ref) DO UPDATE SET sha256 = excluded.sha256, parser = excluded.parser, status = excluded.status, content = excluded.content, error = excluded.error`,
      )
      .run(
        ref,
        basename(ref, extname(ref)),
        this.#parser.identity,
        status,
        content,
        error,
      );
  }
}

async function removed(path: string): Promise<boolean> {
  return lstat(path).then(
    () => false,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return true;
      throw error;
    },
  );
}
