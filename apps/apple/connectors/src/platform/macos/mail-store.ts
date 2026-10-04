import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtempDisposable, readFile, readdir, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  type PlistValue,
  isDictionary,
} from '@workspace/source-apple-macos/plist';
import { readMailPlist } from '@workspace/source-apple-macos/plutil';

export const mailDirectory = join(homedir(), 'Library/Mail');

export class MailUnavailableError extends Error {
  override name = 'MailUnavailableError';
  constructor(path: string, cause: unknown) {
    super(
      `Mail's store at ${path} cannot be read. Grant the exporting process Full Disk Access in System Settings > Privacy & Security.`,
      { cause },
    );
  }
}

export class MailSchemaError extends Error {
  override name = 'MailSchemaError';
}

export class MailChangingError extends Error {
  override name = 'MailChangingError';
}

export function plistJSON(value: PlistValue): string {
  return JSON.stringify(value, (_, item: unknown) =>
    typeof item === 'bigint'
      ? item.toString()
      : item instanceof Uint8Array
        ? Buffer.from(item).toString('base64')
        : item,
  );
}

export function plistObject(value: PlistValue): Record<string, PlistValue> {
  if (!isDictionary(value))
    throw new MailSchemaError('Mail returned a non-dictionary property list');
  return value;
}

export async function mailVersionDirectory(root: string): Promise<string> {
  const info = plistObject(
    await readMailPlist(join(root, 'PersistenceInfo.plist')),
  );
  const version = info.LastUsedVersionDirectoryName;
  if (typeof version !== 'string' || !/^V\d+$/.test(version))
    throw new MailSchemaError('Mail has no valid current version directory');
  return join(root, version);
}

export type MailFile = { path: string; size: number; version: string };

export async function inspectMailFile(path: string): Promise<MailFile> {
  const info = await stat(path, { bigint: true });
  if (!info.isFile())
    throw new MailSchemaError(`Mail content is not a regular file: ${path}`);
  return {
    path,
    size: Number(info.size),
    version: `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`,
  };
}

export async function assertMailFile(file: MailFile): Promise<void> {
  const current = await inspectMailFile(file.path).catch((cause: unknown) => {
    throw new MailChangingError(
      `Mail removed a file during extraction: ${file.path}`,
      { cause },
    );
  });
  if (current.version !== file.version)
    throw new MailChangingError(
      `Mail changed a file during extraction: ${file.path}`,
    );
}

export async function hashMailFile(file: MailFile): Promise<string> {
  await assertMailFile(file);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file.path)) hash.update(chunk);
  await assertMailFile(file);
  return hash.digest('hex');
}

// One read-only index transaction. The file inventory is separate: callers check
// file versions around reads, and keep decoded MIME files in run-scoped storage.
export class MailStore implements AsyncDisposable {
  readonly messages = new Map<string, MailFile>();
  readonly attachments = new Map<string, MailFile[]>();
  readonly plists = new Map<string, MailFile>();
  readonly signatures: MailFile[] = [];
  readonly path: string;
  readonly database: DatabaseSync;
  readonly scratch: Awaited<ReturnType<typeof mkdtempDisposable>>;
  private readonly resources: AsyncDisposableStack;

  private constructor(
    path: string,
    database: DatabaseSync,
    scratch: Awaited<ReturnType<typeof mkdtempDisposable>>,
    resources: AsyncDisposableStack,
  ) {
    this.path = path;
    this.database = database;
    this.scratch = scratch;
    this.resources = resources;
  }

  static async open(
    root: string,
    required: Readonly<Record<string, readonly string[]>>,
  ): Promise<MailStore> {
    let path: string;
    let database: DatabaseSync;
    try {
      path = await mailVersionDirectory(root);
      database = new DatabaseSync(join(path, 'MailData/Envelope Index'), {
        readOnly: true,
      });
    } catch (cause) {
      if (cause instanceof MailSchemaError) throw cause;
      throw new MailUnavailableError(root, cause);
    }
    const resources = new AsyncDisposableStack();
    resources.use(database);
    try {
      database.exec('BEGIN');
      const missing = Object.entries(required).flatMap(([table, columns]) => {
        const present = new Set(
          database
            .prepare('SELECT name FROM pragma_table_info(?)')
            .all(table)
            .map((row) => row.name),
        );
        return columns
          .filter((column) => !present.has(column))
          .map((column) => `${table}.${column}`);
      });
      if (missing.length)
        throw new MailSchemaError(
          `Unsupported Mail index schema: missing ${missing.join(', ')}`,
        );
      const scratch = resources.use(
        await mkdtempDisposable(join(tmpdir(), 'apple-mail-')),
      );
      const store = new MailStore(path, database, scratch, resources);
      const entries = await readdir(path, {
        recursive: true,
        withFileTypes: true,
      });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const filePath = join(entry.parentPath, entry.name);
        const segments = relative(path, filePath).split(sep);
        const attachment = segments.indexOf('Attachments');
        if (/^\d+(\.partial)?\.emlx$/.test(entry.name)) {
          const id = entry.name.slice(0, entry.name.indexOf('.'));
          if (store.messages.has(id))
            throw new MailSchemaError(
              `Mail has more than one file for indexed message ${id}`,
            );
          store.messages.set(id, await inspectMailFile(filePath));
        } else if (attachment !== -1 && segments.length >= attachment + 4) {
          const key = `${segments[attachment + 1]}:${segments[attachment + 2]}`;
          const files = store.attachments.get(key);
          const file = await inspectMailFile(filePath);
          if (files === undefined) store.attachments.set(key, [file]);
          else files.push(file);
        } else if (entry.name.endsWith('.plist')) {
          store.plists.set(
            relative(path, filePath),
            await inspectMailFile(filePath),
          );
        } else if (entry.name.endsWith('.mailsignature')) {
          store.signatures.push(await inspectMailFile(filePath));
        }
      }
      return store;
    } catch (error) {
      await resources.disposeAsync();
      throw error;
    }
  }

  async plist(name: string): Promise<PlistValue | null> {
    const file = this.plists.get(name);
    // A plist that did not exist at open represents no configured entries;
    // a file that disappears or fails parsing after open is an error.
    if (file === undefined) return null;
    await assertMailFile(file);
    const value = await readMailPlist(file.path);
    await assertMailFile(file);
    return value;
  }

  async signature(file: MailFile): Promise<{ id: string; content: string }> {
    await assertMailFile(file);
    const content = await readFile(file.path, 'utf8');
    await assertMailFile(file);
    return { id: basename(file.path, '.mailsignature'), content };
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.resources.disposeAsync();
  }
}
