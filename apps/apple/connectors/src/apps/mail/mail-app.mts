import type { ImportScope } from '@workspace/source-apple-macos/import-scope';
import {
  AppleMailSource,
  restrictedMailStreams,
} from '@workspace/source-apple-mail/apple-mail-source';
import { mailDirectory } from '@workspace/source-apple-mail/mail-store';

import { AppleApp } from '../apple-app.ts';
import { type Choice, type Row, accounts, byId } from '../choice.ts';

const accountName = (row: Row) =>
  String(JSON.parse(String(row.properties)).name);

export default class MailApp extends AppleApp {
  readonly name = 'mail';
  readonly title = 'Mail';
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

  protected access(grantee: string): string {
    return `Allow ${grantee} to control Mail when macOS asks.`;
  }

  protected source(scope: ImportScope) {
    return new AppleMailSource(mailDirectory, scope);
  }
}
