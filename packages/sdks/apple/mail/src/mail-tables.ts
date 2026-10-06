// How the Envelope Index stores a column's values, as rows() reads them:
// - id: an integer, read as decimal text, which keeps 64-bit values exact.
// - text, number and bytes (a BLOB): read as stored, whatever SQLite holds.
// - undatedNumber: a number Mail stores for a date whose epoch is unverified,
//   read as stored.
// - time: Unix seconds, read as a Date with millisecond precision.
export type MailColumnKind =
  'id' | 'text' | 'number' | 'undatedNumber' | 'time' | 'bytes';

// An Envelope Index table: its columns in the index's order, and the key its
// rows are ordered by.
export type MailTable = {
  readonly name: string;
  readonly keys: readonly string[];
  readonly columns: Readonly<Record<string, MailColumnKind>>;
};

// Captured from Mail 16.0 on macOS 26.6.2. Indexing queues and transient sync
// actions stay internal; these are Mail's stored user data and relationships.
export const messagesTable = {
  name: 'messages',
  keys: ['ROWID'],
  columns: {
    ROWID: 'id',
    message_id: 'id',
    global_message_id: 'id',
    remote_id: 'id',
    document_id: 'bytes',
    sender: 'id',
    subject_prefix: 'text',
    subject: 'id',
    summary: 'id',
    date_sent: 'time',
    date_received: 'time',
    mailbox: 'id',
    remote_mailbox: 'id',
    flags: 'number',
    read: 'number',
    flagged: 'number',
    deleted: 'number',
    size: 'number',
    conversation_id: 'id',
    date_last_viewed: 'time',
    list_id_hash: 'id',
    unsubscribe_type: 'number',
    searchable_message: 'id',
    brand_indicator: 'id',
    display_date: 'time',
    flag_color: 'number',
    color: 'text',
    type: 'number',
    fuzzy_ancestor: 'id',
    automated_conversation: 'number',
    root_status: 'number',
    is_urgent: 'number',
  },
} as const satisfies MailTable;

export const mailboxesTable = {
  name: 'mailboxes',
  keys: ['ROWID'],
  columns: {
    ROWID: 'id',
    url: 'text',
    total_count: 'number',
    unread_count: 'number',
    deleted_count: 'number',
    unseen_count: 'number',
    unread_count_adjusted_for_duplicates: 'number',
    change_identifier: 'text',
    source: 'number',
    alleged_change_identifier: 'text',
  },
} as const satisfies MailTable;

export const addressesTable = {
  name: 'addresses',
  keys: ['ROWID'],
  columns: { ROWID: 'id', address: 'text', comment: 'text' },
} as const satisfies MailTable;

export const recipientsTable = {
  name: 'recipients',
  keys: ['ROWID'],
  columns: {
    ROWID: 'id',
    message: 'id',
    address: 'id',
    type: 'number',
    position: 'number',
  },
} as const satisfies MailTable;

export const attachmentsTable = {
  name: 'attachments',
  keys: ['ROWID'],
  columns: { ROWID: 'id', message: 'id', attachment_id: 'text', name: 'text' },
} as const satisfies MailTable;

export const labelsTable = {
  name: 'labels',
  keys: ['message_id', 'mailbox_id'],
  columns: { message_id: 'id', mailbox_id: 'id' },
} as const satisfies MailTable;

export const serverMessagesTable = {
  name: 'server_messages',
  keys: ['ROWID'],
  columns: {
    ROWID: 'id',
    message: 'id',
    mailbox: 'id',
    sequence_identifier: 'number',
    read: 'number',
    deleted: 'number',
    replied: 'number',
    flagged: 'number',
    draft: 'number',
    forwarded: 'number',
    redirected: 'number',
    junk_level_set_by_user: 'number',
    junk_level: 'number',
    flag_color: 'number',
    remote_id: 'id',
  },
} as const satisfies MailTable;

export const serverLabelsTable = {
  name: 'server_labels',
  keys: ['server_message', 'label'],
  columns: { server_message: 'id', label: 'id' },
} as const satisfies MailTable;

export const conversationsTable = {
  name: 'conversations',
  keys: ['conversation_id'],
  columns: { conversation_id: 'id', flags: 'number', sync_key: 'text' },
} as const satisfies MailTable;

export const conversationMessagesTable = {
  name: 'conversation_id_message_id',
  keys: ['conversation_id', 'message_id'],
  columns: { conversation_id: 'id', message_id: 'id', date_sent: 'time' },
} as const satisfies MailTable;

export const messageReferencesTable = {
  name: 'message_references',
  keys: ['ROWID'],
  columns: {
    ROWID: 'id',
    message: 'id',
    reference: 'id',
    is_originator: 'number',
  },
} as const satisfies MailTable;

export const messageGlobalDataTable = {
  name: 'message_global_data',
  keys: ['ROWID'],
  columns: {
    ROWID: 'id',
    message_id: 'id',
    follow_up_start_date: 'undatedNumber',
    follow_up_end_date: 'undatedNumber',
    follow_up_jsonstringformodelevaluationforsuggestions: 'text',
    due_by: 'undatedNumber',
    read_later_date: 'undatedNumber',
    send_later_date: 'undatedNumber',
    validation_state: 'number',
    model_category: 'number',
    model_subcategory: 'number',
    category_model_version: 'number',
    category_is_temporary: 'number',
    model_analytics: 'text',
    model_high_impact: 'number',
    generated_summary: 'id',
    urgent: 'number',
    message_id_header: 'text',
  },
} as const satisfies MailTable;

export const subjectsTable = {
  name: 'subjects',
  keys: ['ROWID'],
  columns: { ROWID: 'id', subject: 'text' },
} as const satisfies MailTable;

export const summariesTable = {
  name: 'summaries',
  keys: ['ROWID'],
  columns: { ROWID: 'id', summary: 'text' },
} as const satisfies MailTable;

export const generatedSummariesTable = {
  name: 'generated_summaries',
  keys: ['ROWID'],
  columns: { ROWID: 'id', summary: 'bytes', status: 'number' },
} as const satisfies MailTable;

export const messageMetadataTable = {
  name: 'message_metadata',
  keys: ['message_id'],
  columns: { message_id: 'id', timestamp: 'number', json_values: 'text' },
} as const satisfies MailTable;

export const dataDetectionResultsTable = {
  name: 'data_detection_results',
  keys: ['ROWID'],
  columns: {
    ROWID: 'id',
    global_message_id: 'id',
    category: 'text',
    value: 'text',
  },
} as const satisfies MailTable;

export const richLinksTable = {
  name: 'rich_links',
  keys: ['ROWID'],
  columns: { ROWID: 'id', title: 'text', url: 'text', hash: 'text' },
} as const satisfies MailTable;

export const messageRichLinksTable = {
  name: 'message_rich_links',
  keys: ['global_message_id', 'rich_link'],
  columns: { global_message_id: 'id', rich_link: 'id' },
} as const satisfies MailTable;

export const protectedMessageDataTable = {
  name: 'protected_message_data',
  keys: ['ROWID'],
  columns: { ROWID: 'id', data: 'text' },
} as const satisfies MailTable;

export const brandIndicatorsTable = {
  name: 'brand_indicators',
  keys: ['ROWID'],
  columns: {
    ROWID: 'id',
    url: 'text',
    indicator: 'bytes',
    indicator_hash: 'text',
    hash_algorithm: 'text',
  },
} as const satisfies MailTable;

export const brandIndicatorEvidenceTable = {
  name: 'brand_indicator_evidence',
  keys: ['ROWID'],
  columns: {
    ROWID: 'id',
    brand_indicator: 'id',
    url: 'text',
    evidence: 'bytes',
    unverified_messages: 'text',
  },
} as const satisfies MailTable;

export const addressMetadataTable = {
  name: 'address_metadata',
  keys: ['ROWID'],
  columns: {
    ROWID: 'id',
    address: 'text',
    smime_capabilities: 'text',
    smime_capabilities_date: 'undatedNumber',
  },
} as const satisfies MailTable;

export const businessesTable = {
  name: 'businesses',
  keys: ['ROWID'],
  columns: {
    ROWID: 'id',
    address_comment: 'text',
    domain: 'text',
    brand_id: 'id',
    localized_brand_name: 'text',
  },
} as const satisfies MailTable;

export const businessAddressesTable = {
  name: 'business_addresses',
  keys: ['ROWID'],
  columns: {
    ROWID: 'id',
    address: 'id',
    business: 'id',
    category: 'number',
    last_modified: 'undatedNumber',
    last_bcs_sync: 'time',
  },
} as const satisfies MailTable;

export const businessCategoriesTable = {
  name: 'business_categories',
  keys: ['ROWID'],
  columns: { ROWID: 'id', business: 'id', category: 'number' },
} as const satisfies MailTable;

export const sendersTable = {
  name: 'senders',
  keys: ['ROWID'],
  columns: {
    ROWID: 'id',
    contact_identifier: 'text',
    bucket: 'number',
    user_initiated: 'number',
  },
} as const satisfies MailTable;

export const senderAddressesTable = {
  name: 'sender_addresses',
  keys: ['address'],
  columns: { address: 'id', sender: 'id' },
} as const satisfies MailTable;

export const eventsTable = {
  name: 'events',
  keys: ['ROWID'],
  columns: {
    ROWID: 'id',
    message_id: 'id',
    start_date: 'undatedNumber',
    end_date: 'undatedNumber',
    location: 'text',
    out_of_date: 'number',
    processed: 'number',
    is_all_day: 'number',
    associated_id_string: 'text',
    original_receiving_account: 'text',
    ical_uid: 'text',
    is_response_requested: 'number',
  },
} as const satisfies MailTable;

// Every table this reader reads, which an index must hold to be read at all.
export const envelopeTables: readonly MailTable[] = [
  messagesTable,
  mailboxesTable,
  addressesTable,
  recipientsTable,
  attachmentsTable,
  labelsTable,
  serverMessagesTable,
  serverLabelsTable,
  conversationsTable,
  conversationMessagesTable,
  messageReferencesTable,
  messageGlobalDataTable,
  subjectsTable,
  summariesTable,
  generatedSummariesTable,
  messageMetadataTable,
  dataDetectionResultsTable,
  richLinksTable,
  messageRichLinksTable,
  protectedMessageDataTable,
  brandIndicatorsTable,
  brandIndicatorEvidenceTable,
  addressMetadataTable,
  businessesTable,
  businessAddressesTable,
  businessCategoriesTable,
  sendersTable,
  senderAddressesTable,
  eventsTable,
];
