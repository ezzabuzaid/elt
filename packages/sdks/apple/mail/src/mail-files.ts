import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, readFile, readdir, stat } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';

import { type PlistValue, readPlist } from '@workspace/sdk-apple-plist';

import type { IndexedAttachment } from './envelope-index.ts';
import { MailChangingError, MailSchemaError } from './errors.ts';
import { plistList, plistObject, requiredString } from './mail-plists.ts';

// One file of Mail's store as it stood when the store was listed. Its version
// is its stat: device, inode, size, and mtime and ctime in nanoseconds; a
// rewrite within one timestamp tick still changes ctime. Every read checks the
// version before and after, so a file Mail changes while it is read fails the
// read.
export class MailFile {
  readonly path: string;
  readonly size: number;
  readonly version: string;

  private constructor(path: string, size: number, version: string) {
    this.path = path;
    this.size = size;
    this.version = version;
  }

  static async inspect(path: string): Promise<MailFile> {
    const info = await stat(path, { bigint: true });
    if (!info.isFile())
      throw new MailSchemaError(`Mail content is not a regular file: ${path}`);
    return new MailFile(
      path,
      Number(info.size),
      `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`,
    );
  }

  async assertUnchanged(): Promise<void> {
    const current = await MailFile.inspect(this.path).catch(
      (cause: unknown) => {
        throw new MailChangingError(
          `Mail removed a file during extraction: ${this.path}`,
          { cause },
        );
      },
    );
    if (current.version !== this.version)
      throw new MailChangingError(
        `Mail changed a file during extraction: ${this.path}`,
      );
  }

  // SHA-256 of the bytes as lowercase hexadecimal.
  async hash(): Promise<string> {
    await this.assertUnchanged();
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(this.path)) hash.update(chunk);
    await this.assertUnchanged();
    return hash.digest('hex');
  }

  async copyTo(target: string): Promise<void> {
    await this.assertUnchanged();
    await copyFile(this.path, target);
    await this.assertUnchanged();
  }
}

// A rule in MailData/SyncedRules.plist or UnsyncedRules.plist.
type MailRule = {
  readonly scope: 'Synced' | 'Unsynced';
  readonly id: string;
  readonly dictionary: Readonly<Record<string, PlistValue>>;
  // The value MailData/RulesActiveState.plist stores for the rule, as stored;
  // null when that file is absent or has no entry for it.
  readonly enabled: PlistValue | null;
  // Its Criteria list, checked only when asked.
  conditions(): PlistValue[];
};

// A smart mailbox in MailData/SyncedSmartMailboxes.plist, nested ones
// included.
type SmartMailbox = {
  readonly id: string;
  // The smart mailbox whose MailboxChildren holds this one; null at the top.
  readonly parentId: string | null;
  readonly dictionary: Readonly<Record<string, PlistValue>>;
  // Its MailboxCriteria list, checked only when asked.
  conditions(): PlistValue[];
};

type MailSignature = { readonly name: string; readonly content: string };

// Code-unit order, not locale order, so the listing is the same everywhere.
function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

const criteria =
  (dictionary: Record<string, PlistValue>, key: string) => () => {
    const value = dictionary[key];
    return value === undefined ? [] : plistList(value);
  };

// Pre-order: each smart mailbox before its children, which are checked only
// once it has been read.
function* smartMailboxTree(
  entries: PlistValue[],
  parentId: string | null,
): Generator<SmartMailbox, void, undefined> {
  for (const entry of entries) {
    const dictionary = plistObject(entry);
    const id = requiredString(dictionary, 'MailboxID');
    yield {
      id,
      parentId,
      dictionary,
      conditions: criteria(dictionary, 'MailboxCriteria'),
    };
    if (dictionary.MailboxChildren !== undefined)
      yield* smartMailboxTree(plistList(dictionary.MailboxChildren), id);
  }
}

// The files of one Mail version folder, listed once: each indexed message's
// .emlx, the attachments Mail downloads apart from their message, property
// lists and signatures. A file listed here that later changes or disappears
// fails its read; one that was absent is absent for the whole read.
export class MailFiles {
  readonly directory: string;
  // By message ROWID: <id>.emlx, or <id>.partial.emlx when its attachments
  // are downloaded apart.
  readonly messages: ReadonlyMap<string, MailFile>;
  // By "<message>:<part>": the files under Attachments/<message>/<part>/, in
  // listing order.
  readonly attachments: ReadonlyMap<string, readonly MailFile[]>;
  readonly signatures: readonly MailFile[];
  // By path relative to the version folder.
  readonly #plists: ReadonlyMap<string, MailFile>;

  private constructor(
    directory: string,
    messages: ReadonlyMap<string, MailFile>,
    attachments: ReadonlyMap<string, readonly MailFile[]>,
    plists: ReadonlyMap<string, MailFile>,
    signatures: readonly MailFile[],
  ) {
    this.directory = directory;
    this.messages = messages;
    this.attachments = attachments;
    this.#plists = plists;
    this.signatures = signatures;
  }

  static async read(directory: string): Promise<MailFiles> {
    const messages = new Map<string, MailFile>();
    const attachments = new Map<string, MailFile[]>();
    const plists = new Map<string, MailFile>();
    const signatures: MailFile[] = [];
    const entries = await readdir(directory, {
      recursive: true,
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const filePath = join(entry.parentPath, entry.name);
      const segments = relative(directory, filePath).split(sep);
      const attachment = segments.indexOf('Attachments');
      if (/^\d+(\.partial)?\.emlx$/.test(entry.name)) {
        const id = entry.name.slice(0, entry.name.indexOf('.'));
        if (messages.has(id))
          throw new MailSchemaError(
            `Mail has more than one file for indexed message ${id}`,
          );
        messages.set(id, await MailFile.inspect(filePath));
      } else if (attachment !== -1 && segments.length >= attachment + 4) {
        const key = `${segments[attachment + 1]}:${segments[attachment + 2]}`;
        const files = attachments.get(key);
        const file = await MailFile.inspect(filePath);
        if (files === undefined) attachments.set(key, [file]);
        else files.push(file);
      } else if (entry.name.endsWith('.plist')) {
        plists.set(
          relative(directory, filePath),
          await MailFile.inspect(filePath),
        );
      } else if (entry.name.endsWith('.mailsignature')) {
        signatures.push(await MailFile.inspect(filePath));
      }
    }
    return new MailFiles(directory, messages, attachments, plists, signatures);
  }

  // The file's path relative to the version folder.
  relative(file: MailFile): string {
    return relative(this.directory, file.path);
  }

  // The Info.plist of each .mbox folder, by relative path.
  mailboxProperties(): MailFile[] {
    return this.#plistsWhere(
      (path) =>
        path.endsWith('/Info.plist') &&
        path.split('/').some((part) => part.endsWith('.mbox')),
    );
  }

  // The property lists under a MailData or Signatures folder, by relative
  // path, except caches: RemoteContentURLCache and BiomeStream.
  configuration(): MailFile[] {
    return this.#plistsWhere(
      (path) =>
        /(^|\/)(Signatures|MailData)\//.test(path) &&
        !/(RemoteContentURLCache|BiomeStream)\//.test(path),
    );
  }

  async plist(file: MailFile): Promise<PlistValue> {
    await file.assertUnchanged();
    const value = await readPlist(file.path);
    await file.assertUnchanged();
    return value;
  }

  async signature(file: MailFile): Promise<MailSignature> {
    await file.assertUnchanged();
    const content = await readFile(file.path, 'utf8');
    await file.assertUnchanged();
    return { name: basename(file.path, '.mailsignature'), content };
  }

  // The file Mail downloaded for an attachment its index records, or
  // undefined before it arrives.
  indexedFile(attachment: IndexedAttachment): MailFile | undefined {
    const key = `${attachment.message}:${attachment.attachmentId}`;
    if (
      typeof attachment.attachmentId !== 'string' ||
      !/^\d+(?:\.\d+)*$/.test(attachment.attachmentId)
    )
      throw new MailSchemaError(`Invalid indexed Mail attachment part ${key}`);
    const candidates = this.attachments.get(key);
    if (candidates !== undefined && candidates.length !== 1)
      throw new MailSchemaError(`Ambiguous indexed Mail attachment ${key}`);
    return candidates?.[0];
  }

  // Synced rules, then unsynced ones, each with its active state. The
  // active-state file is checked before the first rule.
  async *rules(): AsyncGenerator<MailRule, void, undefined> {
    const activeValue = await this.#plistAt('MailData/RulesActiveState.plist');
    const active = activeValue === null ? null : plistObject(activeValue);
    for (const scope of ['Synced', 'Unsynced'] as const) {
      const value = await this.#plistAt(`MailData/${scope}Rules.plist`);
      if (value === null) continue;
      for (const entry of plistList(value)) {
        const dictionary = plistObject(entry);
        const id = requiredString(dictionary, 'RuleId');
        yield {
          scope,
          id,
          dictionary,
          enabled: active?.[id] ?? null,
          conditions: criteria(dictionary, 'Criteria'),
        };
      }
    }
  }

  async *smartMailboxes(): AsyncGenerator<SmartMailbox, void, undefined> {
    const value = await this.#plistAt('MailData/SyncedSmartMailboxes.plist');
    if (value === null) return;
    yield* smartMailboxTree(plistList(value), null);
  }

  // A property list by relative path. One that did not exist when the store
  // was listed holds no entries; one that disappears or fails parsing since
  // is an error.
  async #plistAt(path: string): Promise<PlistValue | null> {
    const file = this.#plists.get(path);
    return file === undefined ? null : this.plist(file);
  }

  #plistsWhere(matches: (path: string) => boolean): MailFile[] {
    return [...this.#plists]
      .filter(([path]) => matches(path))
      .sort(([a], [b]) => compareCodeUnits(a, b))
      .map(([, file]) => file);
  }
}
