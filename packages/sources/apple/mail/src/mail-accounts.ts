import { join } from 'node:path';

import { type Account, mailDataclass } from '@workspace/macos-accounts';

export type AccountRecord = { id: string; properties: string };

// Mail's accounts and SMTP servers as the system Accounts store keeps them.
// Mail names an account's folder, and the host of each of its mailbox URLs,
// after the store's account identifier.
export class MailAccounts {
  readonly #byIdentifier: ReadonlyMap<string, Account>;

  constructor(accounts: readonly Account[]) {
    this.#byIdentifier = new Map(
      accounts.map((account) => [account.identifier, account]),
    );
  }

  // One record per account that owns mailboxes: hosts is each mailbox URL's
  // scheme and host, directory the current Mail version folder. A host the
  // store does not know (an On My Mac account) keeps what its URL says.
  accounts(
    hosts: ReadonlyMap<string, string>,
    directory: string,
  ): AccountRecord[] {
    return [...hosts].map(([host, scheme]) => {
      const account = this.#byIdentifier.get(host);
      return {
        id: host,
        properties: JSON.stringify(
          account === undefined
            ? unknownAccount(host, scheme, directory)
            : mailAccount(account, directory),
        ),
      };
    });
  }

  smtpServers(): AccountRecord[] {
    return [...this.#byIdentifier.values()]
      .filter(({ type }) => type === 'com.apple.account.SMTP')
      .map((server) => {
        const outgoing = server.outgoingMailServer;
        return {
          id: server.identifier,
          properties: JSON.stringify({
            id: server.identifier,
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
    id: account.identifier,
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
    sendingServerId: account.sendingAccountIdentifier,
  };
}

// A mailbox host with no account in the store: On My Mac mailboxes use
// local://, and their account has no settings to read.
function unknownAccount(host: string, scheme: string, directory: string) {
  return {
    id: host,
    name: scheme === 'local' ? 'On My Mac' : null,
    type: scheme,
    parentType: null,
    enabled: null,
    emailAddresses: [],
    fullName: null,
    userName: null,
    serverName: null,
    port: null,
    usesSsl: null,
    directory: join(directory, host),
    sendingServerId: null,
  };
}
