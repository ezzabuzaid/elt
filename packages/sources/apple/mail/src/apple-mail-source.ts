import { ChangeWatcher } from '@zukhruf/async';

import type {
  CopyConfiguration,
  ExtractionCoverage,
  SourceMessage,
  SourceWatchOptions,
  Stream,
} from '@workspace/elt';
import { Catalog, Source } from '@workspace/elt';
import type { AccountsStore } from '@workspace/sdk-apple-accounts';
import { MailStore, StoreUnavailableError } from '@workspace/sdk-apple-mail';
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
  readonly identity = 'apple-mail';
  protected readonly catalog = catalog;
  readonly accounts = catalog.get(readers.accounts.name);
  readonly smtpServers = catalog.get(readers.smtpServers.name);
  readonly messages = catalog.get(readers.messages.name);
  readonly mailboxes = catalog.get(readers.mailboxes.name);
  readonly addresses = catalog.get(readers.addresses.name);
  readonly recipients = catalog.get(readers.recipients.name);
  readonly indexedAttachments = catalog.get(readers.indexedAttachments.name);
  readonly messageMailboxes = catalog.get(readers.messageMailboxes.name);
  readonly serverMessages = catalog.get(readers.serverMessages.name);
  readonly serverMessageMailboxes = catalog.get(
    readers.serverMessageMailboxes.name,
  );
  readonly conversations = catalog.get(readers.conversations.name);
  readonly conversationMessages = catalog.get(
    readers.conversationMessages.name,
  );
  readonly messageReferences = catalog.get(readers.messageReferences.name);
  readonly messageGlobalData = catalog.get(readers.messageGlobalData.name);
  readonly subjects = catalog.get(readers.subjects.name);
  readonly summaries = catalog.get(readers.summaries.name);
  readonly generatedSummaries = catalog.get(readers.generatedSummaries.name);
  readonly messageMetadata = catalog.get(readers.messageMetadata.name);
  readonly dataDetectionResults = catalog.get(
    readers.dataDetectionResults.name,
  );
  readonly richLinks = catalog.get(readers.richLinks.name);
  readonly messageRichLinks = catalog.get(readers.messageRichLinks.name);
  readonly protectedMessageData = catalog.get(
    readers.protectedMessageData.name,
  );
  readonly brandIndicators = catalog.get(readers.brandIndicators.name);
  readonly brandIndicatorEvidence = catalog.get(
    readers.brandIndicatorEvidence.name,
  );
  readonly addressMetadata = catalog.get(readers.addressMetadata.name);
  readonly businesses = catalog.get(readers.businesses.name);
  readonly businessAddresses = catalog.get(readers.businessAddresses.name);
  readonly businessCategories = catalog.get(readers.businessCategories.name);
  readonly senders = catalog.get(readers.senders.name);
  readonly senderAddresses = catalog.get(readers.senderAddresses.name);
  readonly events = catalog.get(readers.events.name);
  readonly mailboxProperties = catalog.get(readers.mailboxProperties.name);
  readonly rules = catalog.get(readers.rules.name);
  readonly ruleConditions = catalog.get(readers.ruleConditions.name);
  readonly smartMailboxes = catalog.get(readers.smartMailboxes.name);
  readonly smartMailboxConditions = catalog.get(
    readers.smartMailboxConditions.name,
  );
  readonly signatures = catalog.get(readers.signatures.name);
  readonly configuration = catalog.get(readers.configuration.name);
  readonly messageFiles = catalog.get(readers.messageFiles.name);
  readonly messageHeaders = catalog.get(readers.messageHeaders.name);
  readonly messageParts = catalog.get(readers.messageParts.name);
  readonly attachments = catalog.get(readers.attachments.name);

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
    signal: AbortSignal | undefined,
  ): AsyncGenerator<SourceMessage> {
    const { name } = configuration.stream;
    const reader = readersByName.get(name);
    if (reader === undefined)
      throw new TypeError(`Unknown Mail stream ${name}`);
    yield* reader.extract(configuration, state, scan, signal);
  }

  // Full Disk Access opens both stores Mail reads: its own and the system's
  // Accounts store, which holds account settings.
  protected override readonly configErrors = [StoreUnavailableError];

  override coverage(_stream: Stream): ExtractionCoverage {
    return { ...localAppleStoreCoverage, selection: this.scope };
  }

  // Mail and its daemon write the index as mail arrives, also while
  // Mail.app is closed, so the store is current only as of its last write.
  override async currentAsOf(): Promise<Date> {
    return this.#store.lastWrite();
  }

  // Polls the store's version, which reports index commits and file changes,
  // and, while an account stream is selected, the Accounts store's; a change
  // there refreshes only the account streams.
  protected override async *observe({
    streams: selected,
    signal,
    clock,
  }: SourceWatchOptions): AsyncGenerator<readonly Stream[]> {
    if (signal.aborted) return;
    using mail = await this.#store.version();
    const accountsSelected = selected.filter(({ name }) =>
      accountStreams.has(name),
    );
    using accounts =
      accountsSelected.length === 0 ? null : this.#accountsVersion();
    const watcher = new ChangeWatcher(
      accounts === null ? [mail] : [mail, accounts],
      {
        interval: pollIntervalMs,
        // The reads are local, data_version and a count of file events: a
        // check that takes the whole interval is stuck.
        timeout: pollIntervalMs,
        clock,
      },
    );
    for await (const outcomes of watcher.watch(signal)) {
      for (const outcome of outcomes.values())
        if (outcome.state === 'failed') throw outcome.error;
      if (outcomes.get(mail)?.state === 'changed') yield selected;
      else if (accounts !== null && outcomes.get(accounts)?.state === 'changed')
        yield accountsSelected;
      else yield [];
    }
  }

  // A store this process cannot open fails the account streams on every run;
  // it does not end the watch over the rest of Mail.
  #accountsVersion() {
    try {
      return this.#accounts.version();
    } catch (error) {
      if (error instanceof StoreUnavailableError) return null;
      throw error;
    }
  }
}
