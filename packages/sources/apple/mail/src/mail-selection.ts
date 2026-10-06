import {
  type EnvelopeIndex,
  addressesTable,
  businessAddressesTable,
  conversationMessagesTable,
  labelsTable,
  mailboxesTable,
  messageGlobalDataTable,
  messageRichLinksTable,
  messagesTable,
  recipientsTable,
  senderAddressesTable,
  serverMessagesTable,
} from '@workspace/sdk-apple-mail';
import {
  type ImportScope,
  selected,
  withinDates,
} from '@workspace/source-apple-macos/import-scope';

// What an import scope keeps: its accounts' mailboxes, the messages in them
// within its dates, and the rows those messages reach through the index. It
// reads every table it uses whole, as its stream reads it, so a value a
// stream would fail on fails the scoped read.
export class MailSelection {
  readonly #scope: ImportScope;
  readonly #mailboxes = new Set<unknown>();
  readonly #messages = new Set<unknown>();
  readonly #hashes = new Set<unknown>();
  readonly #globalMessages = new Set<unknown>();
  readonly #addresses = new Set<unknown>();
  readonly #addressTexts = new Set<unknown>();
  readonly #serverMessages = new Set<unknown>();
  readonly #conversations = new Set<unknown>();
  readonly #richLinks = new Set<unknown>();
  readonly #generatedSummaries = new Set<unknown>();
  readonly #brands = new Set<unknown>();
  readonly #businesses = new Set<unknown>();
  readonly #senders = new Set<unknown>();
  readonly #subjects = new Set<unknown>();
  readonly #summaries = new Set<unknown>();

  constructor(index: EnvelopeIndex, scope: ImportScope) {
    this.#scope = scope;
    for (const row of index.rows(mailboxesTable)) {
      const account =
        typeof row.url === 'string' ? URL.parse(row.url)?.hostname : undefined;
      if (
        selected(scope.accountIds, account) &&
        selected(scope.collectionIds, row.ROWID)
      )
        this.#mailboxes.add(row.ROWID);
    }
    const labelled = new Set<unknown>();
    for (const row of index.rows(labelsTable))
      if (this.#mailboxes.has(row.mailbox_id)) labelled.add(row.message_id);
    for (const row of index.rows(messagesTable)) {
      if (!(
        (this.#mailboxes.has(row.mailbox) ||
          this.#mailboxes.has(row.remote_mailbox) ||
          labelled.has(row.ROWID)) &&
        withinDates(
          scope,
          (row.date_received ?? row.date_sent)?.toISOString() ?? null,
        )
      ))
        continue;
      this.#messages.add(row.ROWID);
      this.#hashes.add(row.message_id);
      this.#globalMessages.add(row.global_message_id);
      this.#addresses.add(row.sender);
      this.#brands.add(row.brand_indicator);
      this.#subjects.add(row.subject);
      this.#summaries.add(row.summary);
    }
    for (const row of index.rows(recipientsTable))
      if (this.#messages.has(row.message)) this.#addresses.add(row.address);
    for (const row of index.rows(addressesTable))
      if (this.#addresses.has(row.ROWID)) this.#addressTexts.add(row.address);
    for (const row of index.rows(serverMessagesTable))
      if (this.#messages.has(row.message) && this.#mailboxes.has(row.mailbox))
        this.#serverMessages.add(row.ROWID);
    for (const row of index.rows(conversationMessagesTable))
      if (this.#hashes.has(row.message_id))
        this.#conversations.add(row.conversation_id);
    for (const row of index.rows(messageRichLinksTable))
      if (this.#globalMessages.has(row.global_message_id))
        this.#richLinks.add(row.rich_link);
    for (const row of index.rows(messageGlobalDataTable))
      if (this.#globalMessages.has(row.ROWID))
        this.#generatedSummaries.add(row.generated_summary);
    for (const row of index.rows(businessAddressesTable))
      if (this.#addresses.has(row.address)) this.#businesses.add(row.business);
    for (const row of index.rows(senderAddressesTable))
      if (this.#addresses.has(row.address)) this.#senders.add(row.sender);
  }

  account(id: unknown): boolean {
    return selected(this.#scope.accountIds, id);
  }

  mailbox(id: unknown): boolean {
    return this.#mailboxes.has(id);
  }

  message(id: unknown): boolean {
    return this.#messages.has(id);
  }

  // A Message-ID hash, as messages.messageId holds it.
  messageHash(hash: unknown): boolean {
    return this.#hashes.has(hash);
  }

  globalMessage(id: unknown): boolean {
    return this.#globalMessages.has(id);
  }

  conversation(id: unknown): boolean {
    return this.#conversations.has(id);
  }

  serverMessage(id: unknown): boolean {
    return this.#serverMessages.has(id);
  }

  address(id: unknown): boolean {
    return this.#addresses.has(id);
  }

  // An address as text, as addresses.address holds it.
  addressText(address: unknown): boolean {
    return this.#addressTexts.has(address);
  }

  subject(id: unknown): boolean {
    return this.#subjects.has(id);
  }

  summary(id: unknown): boolean {
    return this.#summaries.has(id);
  }

  generatedSummary(id: unknown): boolean {
    return this.#generatedSummaries.has(id);
  }

  richLink(id: unknown): boolean {
    return this.#richLinks.has(id);
  }

  brand(id: unknown): boolean {
    return this.#brands.has(id);
  }

  business(id: unknown): boolean {
    return this.#businesses.has(id);
  }

  sender(id: unknown): boolean {
    return this.#senders.has(id);
  }
}
