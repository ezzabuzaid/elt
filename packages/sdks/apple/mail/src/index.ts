export {
  EnvelopeIndex,
  type IndexedAttachment,
  type MailStoredValue,
} from './envelope-index.ts';
export {
  MailChangingError,
  MailSchemaError,
  MailUnavailableError,
} from './errors.ts';
export { MailFile } from './mail-files.ts';
export { mailDirectory, mailVersionDirectory } from './mail-location.ts';
export { type MimePart, readMailMime } from './mail-mime.ts';
export { MailSnapshot, MailStore } from './mail-store.ts';
export {
  type MailColumnKind,
  type MailTable,
  addressMetadataTable,
  addressesTable,
  attachmentsTable,
  brandIndicatorEvidenceTable,
  brandIndicatorsTable,
  businessAddressesTable,
  businessCategoriesTable,
  businessesTable,
  conversationMessagesTable,
  conversationsTable,
  dataDetectionResultsTable,
  eventsTable,
  generatedSummariesTable,
  labelsTable,
  mailboxesTable,
  messageGlobalDataTable,
  messageMetadataTable,
  messageReferencesTable,
  messageRichLinksTable,
  messagesTable,
  protectedMessageDataTable,
  recipientsTable,
  richLinksTable,
  senderAddressesTable,
  sendersTable,
  serverLabelsTable,
  serverMessagesTable,
  subjectsTable,
  summariesTable,
} from './mail-tables.ts';
