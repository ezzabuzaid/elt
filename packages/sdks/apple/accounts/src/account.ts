import { type PlistValue, isDictionary } from '@eltjs/codec-plist';

// Mail's data class. On a parent account (iCloud) its settings hold the mail
// servers the child accounts use.
export const mailDataclass = 'com.apple.Dataclass.Mail';

// Where an account fetches or sends mail. A value the store does not hold is
// null.
export type MailServer = {
  readonly host: string | null;
  readonly port: number | null;
  readonly usesTls: boolean | null;
  readonly userName: string | null;
};

// A data class an account offers or has turned on: one row of either join
// table, keyed by the account and the data class row. The name is null when
// the store holds no row for the data class.
export type AccountDataclass = {
  readonly dataclassId: number;
  readonly name: string | null;
  readonly enabled: boolean;
  readonly provisioned: boolean;
};

// One account in the system Accounts store, as the Accounts framework keeps
// it: Mail, Calendar, Contacts and Notes accounts all live here, often as a
// child of the account the user signed in with (an IMAP account under its
// iCloud or Google account). The child carries its own server settings; its
// parent carries the name, the user and, for iCloud, the mail servers. Which
// stored key answers each question was matched against Mail scripting on
// macOS 27, with Exchange, iCloud and Google accounts.
export class Account {
  // ZACCOUNT.Z_PK, the identity the store keeps unique.
  readonly id: number;
  // ACAccount.identifier; Mail names its account folders after it. The store
  // does not keep it unique.
  readonly identifier: string;
  // The account type's Z_PK.
  readonly typeId: number;
  // ACAccountType.identifier, such as com.apple.account.IMAP.
  readonly type: string;
  readonly parent: Account | null;
  readonly description: string | null;
  readonly username: string | null;
  readonly active: boolean;
  readonly authenticated: boolean | null;
  readonly supportsAuthentication: boolean | null;
  readonly visible: boolean | null;
  readonly warmingUp: boolean | null;
  readonly createdAt: Date | null;
  readonly lastCredentialRenewalRejectedAt: Date | null;
  readonly authenticationType: string | null;
  readonly credentialType: string | null;
  readonly modificationId: string | null;
  // The bundle identifier of the app that owns the account.
  readonly owningBundleId: string | null;
  // Data classes the account offers or has turned on, such as
  // com.apple.Dataclass.Mail, one for each data class row.
  readonly dataclasses: readonly AccountDataclass[];
  // The account's properties, decoded from their keyed archives.
  readonly properties: Readonly<Record<string, PlistValue>>;
  // Per data class settings, such as the iCloud mail servers.
  readonly dataclassProperties: Readonly<Record<string, PlistValue>>;

  constructor(fields: {
    readonly id: number;
    readonly identifier: string;
    readonly typeId: number;
    readonly type: string;
    readonly parent: Account | null;
    readonly description: string | null;
    readonly username: string | null;
    readonly active: boolean;
    readonly authenticated: boolean | null;
    readonly supportsAuthentication: boolean | null;
    readonly visible: boolean | null;
    readonly warmingUp: boolean | null;
    readonly createdAt: Date | null;
    readonly lastCredentialRenewalRejectedAt: Date | null;
    readonly authenticationType: string | null;
    readonly credentialType: string | null;
    readonly modificationId: string | null;
    readonly owningBundleId: string | null;
    readonly dataclasses: readonly AccountDataclass[];
    readonly properties: Readonly<Record<string, PlistValue>>;
    readonly dataclassProperties: Readonly<Record<string, PlistValue>>;
  }) {
    this.id = fields.id;
    this.identifier = fields.identifier;
    this.typeId = fields.typeId;
    this.type = fields.type;
    this.parent = fields.parent;
    this.description = fields.description;
    this.username = fields.username;
    this.active = fields.active;
    this.authenticated = fields.authenticated;
    this.supportsAuthentication = fields.supportsAuthentication;
    this.visible = fields.visible;
    this.warmingUp = fields.warmingUp;
    this.createdAt = fields.createdAt;
    this.lastCredentialRenewalRejectedAt =
      fields.lastCredentialRenewalRejectedAt;
    this.authenticationType = fields.authenticationType;
    this.credentialType = fields.credentialType;
    this.modificationId = fields.modificationId;
    this.owningBundleId = fields.owningBundleId;
    this.dataclasses = fields.dataclasses;
    this.properties = fields.properties;
    this.dataclassProperties = fields.dataclassProperties;
  }

  // Its own description, else its parent's, such as iCloud or Google. The
  // SMTP accounts this was matched on had no description of their own, so
  // they take their parent's.
  get name(): string | null {
    return this.description ?? this.parent?.description ?? null;
  }

  get fullName(): string | null {
    return (
      text(this.properties.ACPropertyFullName) ??
      text(this.parent?.properties.ACPropertyFullName)
    );
  }

  get userName(): string | null {
    return this.username ?? this.parent?.username ?? null;
  }

  // Its own and its parent's identity address, their aliases, their Apple ID
  // aliases and their iCloud Mail address, in that order and each once: a
  // top-level iCloud account holds the last two itself, a child account
  // through its parent.
  get emailAddresses(): string[] {
    return [
      ...new Set(
        [
          this.properties.IdentityEmailAddress,
          this.parent?.properties.IdentityEmailAddress,
          ...aliases(this.properties.EmailAliases),
          ...aliases(this.parent?.properties.EmailAliases),
          ...list(this.properties.appleIDAliases),
          ...list(this.parent?.properties.appleIDAliases),
          mailSettings(this).EmailAddress,
          mailSettings(this.parent).EmailAddress,
        ].flatMap((address) => text(address) ?? []),
      ),
    ];
  }

  // Active, with the data class turned on for it or its parent.
  enabledFor(dataclass: string): boolean {
    return (
      this.active &&
      [this, this.parent].some(
        (owner) =>
          owner?.dataclasses.some(
            ({ name, enabled }) => enabled && name === dataclass,
          ) ?? false,
      )
    );
  }

  // The account this one sends through: an SMTP account, or itself for an
  // Exchange account, which sends through its web service.
  get sendingAccountIdentifier(): string | null {
    return text(this.properties.SendingAccountIdentifier);
  }

  // Where an IMAP or Exchange account fetches mail: its own server settings,
  // else its parent's Mail settings (iCloud), else its Exchange web service.
  get incomingMailServer(): MailServer {
    const mail = this.#parentMail();
    const ews = text(this.properties.EWSExternalURL);
    const exchange = ews === null ? null : URL.parse(ews);
    return {
      host:
        text(this.properties.Hostname) ??
        text(mail.imapHostname) ??
        exchange?.hostname ??
        null,
      port: number(this.properties.PortNumber) ?? number(mail.imapPort),
      usesTls:
        this.#usesTls(mail.imapRequiresSSL) ??
        (exchange === null ? null : exchange.protocol === 'https:'),
      userName: this.userName,
    };
  }

  // Where an SMTP account sends mail: its own settings, else its parent's
  // Mail settings (iCloud). It signs in with its identity address when it
  // has one.
  get outgoingMailServer(): MailServer {
    const mail = this.#parentMail();
    return {
      host: text(this.properties.Hostname) ?? text(mail.smtpHostname),
      port: number(this.properties.PortNumber) ?? number(mail.smtpPort),
      usesTls: this.#usesTls(mail.smtpRequiresSSL),
      userName: text(this.properties.IdentityEmailAddress) ?? this.userName,
    };
  }

  // SSLEnabled is Mail's Use TLS/SSL setting. SSLIsDirect says only whether
  // TLS starts on connecting or through STARTTLS, so false leaves the
  // question to requiresSsl, the parent's setting that iCloud keeps instead
  // of SSLEnabled.
  #usesTls(requiresSsl: PlistValue | undefined): boolean | null {
    return (
      flag(this.properties.SSLEnabled) ??
      (this.properties.SSLIsDirect === true ? true : null) ??
      flag(requiresSsl)
    );
  }

  #parentMail(): Readonly<Record<string, PlistValue>> {
    return mailSettings(this.parent);
  }
}

function mailSettings(
  account: Account | null,
): Readonly<Record<string, PlistValue>> {
  const settings = account?.dataclassProperties[mailDataclass];
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
