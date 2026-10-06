import { setInterval } from 'node:timers/promises';

import type {
  CopyConfiguration,
  ExtractionCoverage,
  SourceMessage,
  SourceWatchOptions,
  Stream,
} from '@workspace/elt';
import { Catalog, Source } from '@workspace/elt';
import {
  type AccountsStore,
  AccountsUnavailableError,
} from '@workspace/sdk-apple-accounts';
import { MailStore } from '@workspace/sdk-apple-mail';
import type { ImportScope } from '@workspace/source-apple-macos/import-scope';
import { localAppleStoreCoverage } from '@workspace/source-apple-macos/local-apple-store-coverage';

import type { AppleMailStream } from './apple-mail-stream.ts';
import { MailScan } from './mail-scan.ts';
import { AccountsStream } from './streams/accounts-stream.ts';
import { AddressMetadataStream } from './streams/address-metadata-stream.ts';
import { AddressesStream } from './streams/addresses-stream.ts';
import { AttachmentsStream } from './streams/attachments-stream.ts';
import { BrandIndicatorEvidenceStream } from './streams/brand-indicator-evidence-stream.ts';
import { BrandIndicatorsStream } from './streams/brand-indicators-stream.ts';
import { BusinessAddressesStream } from './streams/business-addresses-stream.ts';
import { BusinessCategoriesStream } from './streams/business-categories-stream.ts';
import { BusinessesStream } from './streams/businesses-stream.ts';
import { ConfigurationStream } from './streams/configuration-stream.ts';
import { ConversationMessagesStream } from './streams/conversation-messages-stream.ts';
import { ConversationsStream } from './streams/conversations-stream.ts';
import { DataDetectionResultsStream } from './streams/data-detection-results-stream.ts';
import { EventsStream } from './streams/events-stream.ts';
import { GeneratedSummariesStream } from './streams/generated-summaries-stream.ts';
import { IndexedAttachmentsStream } from './streams/indexed-attachments-stream.ts';
import { MailboxPropertiesStream } from './streams/mailbox-properties-stream.ts';
import { MailboxesStream } from './streams/mailboxes-stream.ts';
import { MessageFilesStream } from './streams/message-files-stream.ts';
import { MessageGlobalDataStream } from './streams/message-global-data-stream.ts';
import { MessageHeadersStream } from './streams/message-headers-stream.ts';
import { MessageMailboxesStream } from './streams/message-mailboxes-stream.ts';
import { MessageMetadataStream } from './streams/message-metadata-stream.ts';
import { MessagePartsStream } from './streams/message-parts-stream.ts';
import { MessageReferencesStream } from './streams/message-references-stream.ts';
import { MessageRichLinksStream } from './streams/message-rich-links-stream.ts';
import { MessagesStream } from './streams/messages-stream.ts';
import { ProtectedMessageDataStream } from './streams/protected-message-data-stream.ts';
import { RecipientsStream } from './streams/recipients-stream.ts';
import { RichLinksStream } from './streams/rich-links-stream.ts';
import { RuleConditionsStream } from './streams/rule-conditions-stream.ts';
import { RulesStream } from './streams/rules-stream.ts';
import { SenderAddressesStream } from './streams/sender-addresses-stream.ts';
import { SendersStream } from './streams/senders-stream.ts';
import { ServerMessageMailboxesStream } from './streams/server-message-mailboxes-stream.ts';
import { ServerMessagesStream } from './streams/server-messages-stream.ts';
import { SignaturesStream } from './streams/signatures-stream.ts';
import { SmartMailboxConditionsStream } from './streams/smart-mailbox-conditions-stream.ts';
import { SmartMailboxesStream } from './streams/smart-mailboxes-stream.ts';
import { SmtpServersStream } from './streams/smtp-servers-stream.ts';
import { SubjectsStream } from './streams/subjects-stream.ts';
import { SummariesStream } from './streams/summaries-stream.ts';

const readers = {
  accounts: new AccountsStream(),
  smtpServers: new SmtpServersStream(),
  messages: new MessagesStream(),
  mailboxes: new MailboxesStream(),
  addresses: new AddressesStream(),
  recipients: new RecipientsStream(),
  indexedAttachments: new IndexedAttachmentsStream(),
  messageMailboxes: new MessageMailboxesStream(),
  serverMessages: new ServerMessagesStream(),
  serverMessageMailboxes: new ServerMessageMailboxesStream(),
  conversations: new ConversationsStream(),
  conversationMessages: new ConversationMessagesStream(),
  messageReferences: new MessageReferencesStream(),
  messageGlobalData: new MessageGlobalDataStream(),
  subjects: new SubjectsStream(),
  summaries: new SummariesStream(),
  generatedSummaries: new GeneratedSummariesStream(),
  messageMetadata: new MessageMetadataStream(),
  dataDetectionResults: new DataDetectionResultsStream(),
  richLinks: new RichLinksStream(),
  messageRichLinks: new MessageRichLinksStream(),
  protectedMessageData: new ProtectedMessageDataStream(),
  brandIndicators: new BrandIndicatorsStream(),
  brandIndicatorEvidence: new BrandIndicatorEvidenceStream(),
  addressMetadata: new AddressMetadataStream(),
  businesses: new BusinessesStream(),
  businessAddresses: new BusinessAddressesStream(),
  businessCategories: new BusinessCategoriesStream(),
  senders: new SendersStream(),
  senderAddresses: new SenderAddressesStream(),
  events: new EventsStream(),
  mailboxProperties: new MailboxPropertiesStream(),
  rules: new RulesStream(),
  ruleConditions: new RuleConditionsStream(),
  smartMailboxes: new SmartMailboxesStream(),
  smartMailboxConditions: new SmartMailboxConditionsStream(),
  signatures: new SignaturesStream(),
  configuration: new ConfigurationStream(),
  messageFiles: new MessageFilesStream(),
  messageHeaders: new MessageHeadersStream(),
  messageParts: new MessagePartsStream(),
  attachments: new AttachmentsStream(),
} satisfies Record<string, AppleMailStream>;
const catalog = new Catalog(
  Object.values(readers).map((reader) => reader.describe()),
);
const readersByName = new Map<string, AppleMailStream>(
  Object.values(readers).map((reader) => [reader.name, reader]),
);
// The streams read from the system Accounts store, which commits apart from
// Mail.
const accountStreams: ReadonlySet<string> = new Set([
  readers.accounts.name,
  readers.smtpServers.name,
]);
// How often a watch checks the store for changes.
const pollIntervalMs = 1000;

// These native records have no proven account/message ownership. A restricted
// import omits them rather than copying unrelated settings or guessing joins.
export const restrictedMailStreams = [
  'messageMetadata',
  'dataDetectionResults',
  'protectedMessageData',
  'smtpServers',
  'mailboxProperties',
  'configuration',
  'rules',
  'ruleConditions',
  'smartMailboxes',
  'smartMailboxConditions',
  'signatures',
] as const;

export class AppleMailSource extends Source<MailScan> {
  readonly identity: string;
  protected readonly catalog = catalog;
  readonly accounts = readers.accounts.describe();
  readonly smtpServers = readers.smtpServers.describe();
  readonly messages = readers.messages.describe();
  readonly mailboxes = readers.mailboxes.describe();
  readonly addresses = readers.addresses.describe();
  readonly recipients = readers.recipients.describe();
  readonly indexedAttachments = readers.indexedAttachments.describe();
  readonly messageMailboxes = readers.messageMailboxes.describe();
  readonly serverMessages = readers.serverMessages.describe();
  readonly serverMessageMailboxes = readers.serverMessageMailboxes.describe();
  readonly conversations = readers.conversations.describe();
  readonly conversationMessages = readers.conversationMessages.describe();
  readonly messageReferences = readers.messageReferences.describe();
  readonly messageGlobalData = readers.messageGlobalData.describe();
  readonly subjects = readers.subjects.describe();
  readonly summaries = readers.summaries.describe();
  readonly generatedSummaries = readers.generatedSummaries.describe();
  readonly messageMetadata = readers.messageMetadata.describe();
  readonly dataDetectionResults = readers.dataDetectionResults.describe();
  readonly richLinks = readers.richLinks.describe();
  readonly messageRichLinks = readers.messageRichLinks.describe();
  readonly protectedMessageData = readers.protectedMessageData.describe();
  readonly brandIndicators = readers.brandIndicators.describe();
  readonly brandIndicatorEvidence = readers.brandIndicatorEvidence.describe();
  readonly addressMetadata = readers.addressMetadata.describe();
  readonly businesses = readers.businesses.describe();
  readonly businessAddresses = readers.businessAddresses.describe();
  readonly businessCategories = readers.businessCategories.describe();
  readonly senders = readers.senders.describe();
  readonly senderAddresses = readers.senderAddresses.describe();
  readonly events = readers.events.describe();
  readonly mailboxProperties = readers.mailboxProperties.describe();
  readonly rules = readers.rules.describe();
  readonly ruleConditions = readers.ruleConditions.describe();
  readonly smartMailboxes = readers.smartMailboxes.describe();
  readonly smartMailboxConditions = readers.smartMailboxConditions.describe();
  readonly signatures = readers.signatures.describe();
  readonly configuration = readers.configuration.describe();
  readonly messageFiles = readers.messageFiles.describe();
  readonly messageHeaders = readers.messageHeaders.describe();
  readonly messageParts = readers.messageParts.describe();
  readonly attachments = readers.attachments.describe();

  readonly path: string;
  readonly scope: ImportScope;
  readonly #store: MailStore;
  readonly #accounts: AccountsStore;

  constructor({
    path,
    accounts,
    scope = {},
  }: {
    // The Mail store root, such as ~/Library/Mail.
    path: string;
    // The system Accounts store, which holds Mail's account settings.
    accounts: AccountsStore;
    scope?: ImportScope;
  }) {
    super();
    this.path = path;
    this.#store = new MailStore(path);
    this.#accounts = accounts;
    this.scope = scope;
    this.identity = `apple-mail:${path}`;
    Object.freeze(this);
  }

  protected override open(): Promise<MailScan> {
    return MailScan.open(this.#store, this.#accounts, this.scope);
  }

  protected override async *extract(
    configuration: CopyConfiguration,
    state: unknown,
    _partition: null,
    scan: MailScan,
  ): AsyncGenerator<SourceMessage> {
    const { name } = configuration.stream;
    const reader = readersByName.get(name);
    if (reader === undefined)
      throw new TypeError(`Unknown Mail stream ${name}`);
    yield* reader.extract(configuration, state, scan);
  }

  override coverage(_stream: Stream): ExtractionCoverage {
    return { ...localAppleStoreCoverage, selection: this.scope };
  }

  // Polls the store's version, which reports index commits and file changes,
  // and, while an account stream is selected, the Accounts store's; a change
  // there refreshes only the account streams.
  protected override async *observe({
    streams: selected,
    signal,
  }: SourceWatchOptions): AsyncGenerator<readonly Stream[]> {
    if (signal.aborted) return;
    using version = await this.#store.version();
    let seen = version.current;
    const accountsSelected = selected.filter(({ name }) =>
      accountStreams.has(name),
    );
    using accounts =
      accountsSelected.length === 0 ? null : this.#accountsVersion();
    let accountsSeen = accounts?.current;
    yield selected;
    try {
      for await (const _ of setInterval(pollIntervalMs, undefined, {
        signal,
      })) {
        const current = version.current;
        const accountsCurrent = accounts?.current;
        if (current !== seen) {
          seen = current;
          accountsSeen = accountsCurrent;
          yield selected;
        } else if (accountsCurrent !== accountsSeen) {
          accountsSeen = accountsCurrent;
          yield accountsSelected;
        }
      }
    } catch (error) {
      if (!(
        signal.aborted &&
        error instanceof Error &&
        error.name === 'AbortError'
      ))
        throw error;
    }
  }

  // A store this process cannot open fails the account streams on every run;
  // it does not end the watch over the rest of Mail.
  #accountsVersion() {
    try {
      return this.#accounts.version();
    } catch (error) {
      if (error instanceof AccountsUnavailableError) return null;
      throw error;
    }
  }
}
