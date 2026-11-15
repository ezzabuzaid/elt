import { join } from 'node:path';

import { type Account, mailDataclass } from '@eltjs/sdk-apple-accounts';

// id is the account's row in the Accounts store (ZACCOUNT.Z_PK), the identity
// the store keeps unique; identifier is ACAccount.identifier, which it does
// not (ADR 0022).
export type AccountRecord = {
  id: number;
  identifier: string;
  properties: string;
};

// Mail's accounts and SMTP servers as the system Accounts store keeps them.
// Mail names an account's folder, and the host of each of its mailbox URLs,
// after the store's account identifier.
export class MailAccounts {
  readonly #accounts: readonly Account[];

  constructor(accounts: readonly Account[]) {
    this.#accounts = accounts;
  }

  // One record per store account that owns mailboxes: one whose identifier is
  // the host of a mailbox URL. directory is the current Mail version folder.
  // An On My Mac host (local://) has no row in the store, so no record.
  accounts(hosts: ReadonlySet<string>, directory: string): AccountRecord[] {
    return this.#accounts
      .filter(({ identifier }) => hosts.has(identifier))
      .map((account) => ({
        id: account.id,
        identifier: account.identifier,
        properties: JSON.stringify(mailAccount(account, directory)),
      }));
  }

  smtpServers(): AccountRecord[] {
    return this.#accounts
      .filter(({ type }) => type === 'com.apple.account.SMTP')
      .map((server) => {
        const outgoing = server.outgoingMailServer;
        return {
          id: server.id,
          identifier: server.identifier,
          properties: JSON.stringify({
            name: server.name,
            userName: outgoing.userName,
            serverName: outgoing.host,
            port: outgoing.port,
            usesSsl: outgoing.usesTls,
            enabled: server.active,
          }),
        };
      });
  }
}

function mailAccount(account: Account, directory: string) {
  const incoming = account.incomingMailServer;
  return {
    name: account.name,
    type: account.type,
    parentType: account.parent?.type ?? null,
    enabled: account.enabledFor(mailDataclass),
    emailAddresses: account.emailAddresses,
    fullName: account.fullName,
    userName: account.userName,
    serverName: incoming.host,
    port: incoming.port,
    usesSsl: incoming.usesTls,
    directory: join(directory, account.identifier),
    sendingServerIdentifier: account.sendingAccountIdentifier,
  };
}
