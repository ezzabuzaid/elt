import { AppleConnector } from '@workspace/connector-apple-connector/apple-connector';
import {
  type Choice,
  type Row,
  accounts,
  byId,
} from '@workspace/connector-apple-connector/choice';
import { readSQLite } from '@workspace/elt-sqlite';
import {
  AccountsStore,
  accountsStorePath,
} from '@workspace/sdk-apple-accounts';
import { MailChangingError, mailDirectory } from '@workspace/sdk-apple-mail';
import type { ImportScope } from '@workspace/source-apple-macos/import-scope';
import {
  AppleMailSource,
  restrictedMailStreams,
} from '@workspace/source-apple-mail/apple-mail-source';

import { mailContentStatus } from './mail-content-status.ts';
import { mailCounterparts } from './mail-counterparts.ts';

const accountName = (row: Row) =>
  String(JSON.parse(String(row.properties)).name);

export default class MailConnector extends AppleConnector {
  readonly datedBy = 'date received (date sent if missing)';
  readonly fullDiskAccess = true;
  protected readonly choices: readonly Choice[] = [
    accounts(accountName),
    {
      stream: 'mailboxes',
      scope: 'collectionIds',
      title: 'mailboxes',
      id: byId,
      // A mailbox URL names its account as the host.
      label: (row, rows) => {
        const url = new URL(String(row.url));
        const account = rows
          .get('accounts')
          ?.find(({ id }) => id === url.hostname);
        const path = decodeURIComponent(url.pathname.slice(1));
        return account === undefined
          ? path
          : `${accountName(account)} / ${path}`;
      },
    },
  ];
  protected readonly unscoped = restrictedMailStreams;
  // Each message's raw .emlx; messageParts already holds its decoded text.
  protected readonly storeCopies = ['messageFiles'];

  // accounts, messages, addresses and recipients, which the view reads, are
  // in every import, narrowed or not.
  protected override views() {
    return [mailCounterparts, mailContentStatus];
  }

  override contentStatus(path: string): readonly string[] {
    using database = readSQLite(path);
    const boundary =
      'This import reads the local Mail store. Cloud inbox freshness is unknown.';
    if (
      database
        .prepare(
          "SELECT 1 FROM sqlite_schema WHERE type = 'view' AND name = 'mail_content_status'",
        )
        .get() === undefined
    )
      return [
        boundary,
        'Content availability is not known until the Mail content streams finish importing.',
      ];
    const row = database.prepare('SELECT * FROM mail_content_status').get();
    if (row === undefined) return [boundary];
    return [
      boundary,
      row.latest_received_at === null
        ? 'No locally received message date is available in this selection.'
        : `Newest locally received message: ${row.latest_received_at}.`,
      `${row.message_count} messages: ${row.missing_message_files} without a downloaded message file; ${row.missing_text_bodies} without readable body text.`,
      `${row.attachment_count} attachments: ${row.unavailable_attachments} unavailable on this Mac.`,
      'To obtain newer or missing content, let Mail download it from its accounts, then sync this import.',
    ];
  }

  protected override retryImport(error: unknown): boolean {
    return error instanceof MailChangingError;
  }

  protected access(): string {
    return 'The import reads Mail’s local store even while Mail is closed. Open Mail and let its accounts update to download newer messages and missing content; syncing this import does not fetch cloud mail. Account settings come from the macOS Accounts store.';
  }

  protected source(scope: ImportScope) {
    return new AppleMailSource({
      path: mailDirectory,
      accounts: new AccountsStore(accountsStorePath),
      scope,
    });
  }
}
