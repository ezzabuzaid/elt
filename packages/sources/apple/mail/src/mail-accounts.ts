import { join } from 'node:path';

import type { Account } from '@workspace/macos-accounts';
import { type PlistValue, isDictionary } from '@workspace/macos-plist';

const mailDataclass = 'com.apple.Dataclass.Mail';

export type AccountRecord = { id: string; properties: string };

// Mail's accounts and SMTP servers as the system Accounts store keeps them.
// Mail names an account's folder, and the host of each of its mailbox URLs,
// after the store's account identifier. A child account (IMAP under iCloud or
// Google) carries its server settings; its parent carries the name, the user
// and, for iCloud, the mail servers. Which stored key holds each value was
// matched against Mail scripting on macOS 27.
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
            : this.#account(account, directory),
        ),
      };
    });
  }

  smtpServers(): AccountRecord[] {
    return [...this.#byIdentifier.values()]
      .filter(({ type }) => type === 'com.apple.account.SMTP')
      .map((server) => {
        const parent = this.#parent(server);
        const mail = dataclass(parent, mailDataclass);
        return {
          id: server.identifier,
          properties: JSON.stringify({
            id: server.identifier,
            name: parent?.description ?? null,
            userName:
              text(server.properties.IdentityEmailAddress) ??
              server.username ??
              parent?.username ??
              null,
            serverName:
              text(server.properties.Hostname) ?? text(mail.smtpHostname),
            port: number(server.properties.PortNumber) ?? number(mail.smtpPort),
            usesSsl: usesSsl(server, mail.smtpRequiresSSL),
            enabled: server.active,
          }),
        };
      });
  }

  #account(account: Account, directory: string) {
    const parent = this.#parent(account);
    const mail = dataclass(parent, mailDataclass);
    const ews = text(account.properties.EWSExternalURL);
    const exchange = ews === null ? null : URL.parse(ews);
    return {
      id: account.identifier,
      name: account.description ?? parent?.description ?? null,
      type: account.type,
      parentType: parent?.type ?? null,
      enabled:
        account.active &&
        [account, parent].some(
          (owner) => owner?.enabledDataclasses.includes(mailDataclass) ?? false,
        ),
      emailAddresses: [
        ...new Set(
          [
            account.properties.IdentityEmailAddress,
            parent?.properties.IdentityEmailAddress,
            ...aliases(account.properties.EmailAliases),
            ...aliases(parent?.properties.EmailAliases),
            ...list(parent?.properties.appleIDAliases),
            mail.EmailAddress,
          ].flatMap((address) => text(address) ?? []),
        ),
      ],
      fullName:
        text(account.properties.ACPropertyFullName) ??
        text(parent?.properties.ACPropertyFullName),
      userName: account.username ?? parent?.username ?? null,
      serverName:
        text(account.properties.Hostname) ??
        text(mail.imapHostname) ??
        exchange?.hostname ??
        null,
      port: number(account.properties.PortNumber) ?? number(mail.imapPort),
      usesSsl:
        usesSsl(account, mail.imapRequiresSSL) ??
        (exchange === null ? null : exchange.protocol === 'https:'),
      directory: join(directory, account.identifier),
      sendingServerId: text(account.properties.SendingAccountIdentifier),
    };
  }

  #parent(account: Account): Account | undefined {
    return account.parent === null
      ? undefined
      : this.#byIdentifier.get(account.parent);
  }
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

// SSLEnabled is Mail's Use TLS/SSL setting. SSLIsDirect says only whether TLS
// starts on connecting or through STARTTLS, so false leaves the question to
// requiresSsl, the parent's setting that iCloud keeps instead of SSLEnabled.
function usesSsl(
  account: Account,
  requiresSsl: PlistValue | undefined,
): boolean | null {
  return (
    flag(account.properties.SSLEnabled) ??
    (account.properties.SSLIsDirect === true ? true : null) ??
    flag(requiresSsl)
  );
}

function dataclass(
  account: Account | undefined,
  name: string,
): Record<string, PlistValue> {
  const settings = account?.dataclassProperties[name];
  return isDictionary(settings) ? settings : {};
}

// Exchange and Google aliases: entries of {DisplayName, IsEnabled,
// EmailAddresses, IsPrimary}.
function aliases(value: PlistValue | undefined): PlistValue[] {
  return list(value).flatMap((entry) =>
    isDictionary(entry) ? list(entry.EmailAddresses) : [],
  );
}

function list(value: PlistValue | undefined): PlistValue[] {
  return Array.isArray(value) ? value : [];
}

function text(value: PlistValue | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function number(value: PlistValue | undefined): number | null {
  return typeof value === 'number' ? value : null;
}

function flag(value: PlistValue | undefined): boolean | null {
  return typeof value === 'boolean' ? value : null;
}
