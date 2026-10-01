import { mailDirectory } from 'apple/platform/macos/mail-store';
import {
  AppleMailSource,
  restrictedMailStreams,
} from 'apple/sources/apple-mail/apple-mail-source';
import type { ImportScope } from 'import-store';
import { AppleApp } from './apple-app.ts';
import { accounts, byId, type Choice, type Row } from './choice.ts';

const accountName = (row: Row) =>
  String(JSON.parse(String(row.properties)).name);

export class MailApp extends AppleApp {
  readonly name = 'mail';
  readonly title = 'Mail';
  readonly datedBy = 'date received';
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

  protected access(terminal: string): string {
    return `${this.fullDiskAccess(terminal)} Allow ${terminal} to control Mail when macOS asks.`;
  }

  protected source(scope: ImportScope) {
    return new AppleMailSource(mailDirectory, scope);
  }
}
