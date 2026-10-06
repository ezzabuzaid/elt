import { createHash } from 'node:crypto';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AccountsStore } from '@workspace/sdk-apple-accounts';
import type {
  IndexedAttachment,
  MailFile,
  MailSnapshot,
  MailStore,
} from '@workspace/sdk-apple-mail';
import type { ImportScope } from '@workspace/source-apple-macos/import-scope';

import { type AccountRecord, MailAccounts } from './mail-accounts.ts';
import { MailSelection } from './mail-selection.ts';

// Part of every message group's fingerprint: raise it whenever parsing or a
// message stream's records change, so saved messages are read again.
const messageParserVersion = 1;

// Code unit order, so a message's detached files are read in a stable order.
function compareKeys(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

type MailAccountRecords = {
  readonly accounts: AccountRecord[];
  readonly smtpServers: AccountRecord[];
};

// Each message's inputs besides its .emlx: detached files by part, and the
// attachment rows the index knows for it.
type MessageInputs = {
  readonly detached: ReadonlyMap<string, [string, readonly MailFile[]][]>;
  readonly indexed: ReadonlyMap<string, IndexedAttachment[]>;
};

// One run's read of Mail: every stream reads the same snapshot, decoded
// attachments are staged in run-scoped storage, and the import scope's
// selection is worked out when the read opens, so a store it cannot read
// fails the whole read.
export class MailScan implements AsyncDisposable {
  readonly snapshot: MailSnapshot;
  // null when the import takes everything.
  readonly selection: MailSelection | null;
  // Where decoded attachments are staged while their records are read.
  readonly scratch: string;
  readonly #resources: AsyncDisposableStack;
  readonly #accountsStore: AccountsStore;
  #accounts: MailAccountRecords | null = null;
  #inputs: MessageInputs | null = null;

  private constructor(
    resources: AsyncDisposableStack,
    snapshot: MailSnapshot,
    scratch: string,
    selection: MailSelection | null,
    accounts: AccountsStore,
  ) {
    this.#resources = resources;
    this.snapshot = snapshot;
    this.scratch = scratch;
    this.selection = selection;
    this.#accountsStore = accounts;
  }

  static async open(
    store: MailStore,
    accounts: AccountsStore,
    scope: ImportScope,
  ): Promise<MailScan> {
    await using resources = new AsyncDisposableStack();
    const snapshot = resources.use(await store.open());
    const scratch = resources.use(
      await mkdtempDisposable(join(tmpdir(), 'apple-mail-')),
    );
    const selection =
      Object.keys(scope).length === 0
        ? null
        : new MailSelection(snapshot.index, scope);
    return new MailScan(
      resources.move(),
      snapshot,
      scratch.path,
      selection,
      accounts,
    );
  }

  // Read once per scan, and only by the two account streams: a store this
  // process cannot open fails those copies, not the rest of Mail.
  accountRecords(): MailAccountRecords {
    if (this.#accounts !== null) return this.#accounts;
    const hosts = new Map<string, string>();
    for (const url of this.snapshot.index.mailboxUrls()) {
      // mailboxes.url is NOT NULL in the index.
      const parsed = new URL(String(url));
      if (!hosts.has(parsed.hostname))
        hosts.set(parsed.hostname, parsed.protocol.slice(0, -1));
    }
    using snapshot = this.#accountsStore.open();
    const accounts = new MailAccounts(snapshot.accounts());
    this.#accounts = {
      accounts: accounts.accounts(hosts, this.snapshot.directory),
      smtpServers: accounts.smtpServers(),
    };
    return this.#accounts;
  }

  // Gathered once per scan, for the messages the selection keeps.
  messageInputs(): MessageInputs {
    if (this.#inputs !== null) return this.#inputs;
    const detached = new Map<string, [string, readonly MailFile[]][]>();
    for (const [key, files] of [...this.snapshot.files.attachments].sort(
      ([a], [b]) => compareKeys(a, b),
    )) {
      const id = key.slice(0, key.indexOf(':'));
      detached.set(id, [...(detached.get(id) ?? []), [key, files]]);
    }
    const indexed = new Map<string, IndexedAttachment[]>();
    for (const row of this.snapshot.index.indexedAttachments()) {
      if (this.selection !== null && !this.selection.message(row.message))
        continue;
      indexed.set(row.message, [...(indexed.get(row.message) ?? []), row]);
    }
    this.#inputs = { detached, indexed };
    return this.#inputs;
  }

  // Everything a message's records are read from: the .emlx and detached
  // files by their versions, and the index's attachment rows. A file that
  // changes while it is read fails the read, so a matching fingerprint means
  // the saved records came from these inputs.
  fingerprint(id: string, file: MailFile | undefined): string {
    const { detached, indexed } = this.messageInputs();
    const identity = (input: MailFile) => [
      this.snapshot.files.relative(input),
      input.version,
    ];
    return createHash('sha256')
      .update(
        JSON.stringify([
          messageParserVersion,
          file === undefined ? null : identity(file),
          (detached.get(id) ?? []).map(([key, files]) => [
            key,
            files.map(identity),
          ]),
          (indexed.get(id) ?? []).map((row) => [row.attachmentId, row.name]),
        ]),
      )
      .digest('base64url');
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.#resources.disposeAsync();
  }
}
