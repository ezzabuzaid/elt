import { type FieldSchema, Stream } from 'elt';

// Only confirmed Unix dates are converted. Unprobed native dates keep their raw
// numbers, with a Raw suffix, instead of guessing their epoch or sentinel values.
const fieldName = (column: string, kind: string) =>
  (column === 'ROWID'
    ? 'id'
    : column.replace(/_([a-z])/g, (_, letter: string) =>
        letter.toUpperCase(),
      )) +
  (kind === 'base64'
    ? 'Base64'
    : kind === 'number' && /date|timestamp|last_modified/.test(column)
      ? 'Raw'
      : '');

function table(
  name: string,
  keys: readonly string[],
  columns: Readonly<
    Record<string, 'text' | 'number' | 'time' | 'base64' | 'id'>
  >,
) {
  const properties: Record<string, FieldSchema> = {};
  const select: string[] = [];
  const blobs: string[] = [];
  for (const [column, kind] of Object.entries(columns)) {
    const field = fieldName(column, kind);
    const scalar =
      kind === 'number'
        ? keys.includes(column)
          ? 'integer'
          : 'number'
        : 'string';
    properties[field] = {
      type: keys.includes(column) ? scalar : [scalar, 'null'],
      ...(kind === 'time' ? { format: 'date-time' as const } : {}),
    };
    const expression =
      kind === 'id'
        ? `CAST("${column}" AS TEXT)`
        : kind === 'time'
          ? `strftime('%Y-%m-%dT%H:%M:%fZ', "${column}", 'unixepoch')`
          : `"${column}"`;
    select.push(`${expression} AS "${field}"`);
    if (kind === 'base64') blobs.push(field);
  }
  return {
    name,
    columns: Object.keys(columns),
    properties,
    primaryKey: keys.map((key) => fieldName(key, columns[key] as string)),
    blobs,
    sql: `SELECT ${select.join(', ')} FROM "${name}" ORDER BY ${keys.map((key) => `"${key}"`).join(', ')}`,
  };
}

// Captured schema only, no personal data. Indexing queues and transient sync
// actions stay internal; these are Mail's stored user data and relationships.
export const mailTables = {
  messages: table('messages', ['ROWID'], {
    ROWID: 'id',
    message_id: 'id',
    global_message_id: 'id',
    remote_id: 'id',
    document_id: 'base64',
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
  }),
  mailboxes: table('mailboxes', ['ROWID'], {
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
  }),
  addresses: table('addresses', ['ROWID'], {
    ROWID: 'id',
    address: 'text',
    comment: 'text',
  }),
  recipients: table('recipients', ['ROWID'], {
    ROWID: 'id',
    message: 'id',
    address: 'id',
    type: 'number',
    position: 'number',
  }),
  indexedAttachments: table('attachments', ['ROWID'], {
    ROWID: 'id',
    message: 'id',
    attachment_id: 'text',
    name: 'text',
  }),
  messageMailboxes: table('labels', ['message_id', 'mailbox_id'], {
    message_id: 'id',
    mailbox_id: 'id',
  }),
  serverMessages: table('server_messages', ['ROWID'], {
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
  }),
  serverMessageMailboxes: table('server_labels', ['server_message', 'label'], {
    server_message: 'id',
    label: 'id',
  }),
  conversations: table('conversations', ['conversation_id'], {
    conversation_id: 'id',
    flags: 'number',
    sync_key: 'text',
  }),
  conversationMessages: table(
    'conversation_id_message_id',
    ['conversation_id', 'message_id'],
    { conversation_id: 'id', message_id: 'id', date_sent: 'time' },
  ),
  messageReferences: table('message_references', ['ROWID'], {
    ROWID: 'id',
    message: 'id',
    reference: 'id',
    is_originator: 'number',
  }),
  messageGlobalData: table('message_global_data', ['ROWID'], {
    ROWID: 'id',
    message_id: 'id',
    follow_up_start_date: 'number',
    follow_up_end_date: 'number',
    follow_up_jsonstringformodelevaluationforsuggestions: 'text',
    download_state: 'number',
    read_later_date: 'number',
    send_later_date: 'number',
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
  }),
  subjects: table('subjects', ['ROWID'], { ROWID: 'id', subject: 'text' }),
  summaries: table('summaries', ['ROWID'], { ROWID: 'id', summary: 'text' }),
  generatedSummaries: table('generated_summaries', ['ROWID'], {
    ROWID: 'id',
    summary: 'base64',
    status: 'number',
  }),
  messageMetadata: table('message_metadata', ['message_id'], {
    message_id: 'id',
    timestamp: 'number',
    json_values: 'text',
  }),
  dataDetectionResults: table('data_detection_results', ['ROWID'], {
    ROWID: 'id',
    global_message_id: 'id',
    category: 'text',
    value: 'text',
  }),
  richLinks: table('rich_links', ['ROWID'], {
    ROWID: 'id',
    title: 'text',
    url: 'text',
    hash: 'text',
  }),
  messageRichLinks: table(
    'message_rich_links',
    ['global_message_id', 'rich_link'],
    { global_message_id: 'id', rich_link: 'id' },
  ),
  protectedMessageData: table('protected_message_data', ['ROWID'], {
    ROWID: 'id',
    data: 'text',
  }),
  brandIndicators: table('brand_indicators', ['ROWID'], {
    ROWID: 'id',
    url: 'text',
    indicator: 'base64',
    indicator_hash: 'text',
    hash_algorithm: 'text',
  }),
  brandIndicatorEvidence: table('brand_indicator_evidence', ['ROWID'], {
    ROWID: 'id',
    brand_indicator: 'id',
    url: 'text',
    evidence: 'base64',
    unverified_messages: 'text',
  }),
  addressMetadata: table('address_metadata', ['ROWID'], {
    ROWID: 'id',
    address: 'text',
    smime_capabilities: 'text',
    smime_capabilities_date: 'number',
  }),
  businesses: table('businesses', ['ROWID'], {
    ROWID: 'id',
    address_comment: 'text',
    domain: 'text',
    brand_id: 'id',
    localized_brand_name: 'text',
  }),
  businessAddresses: table('business_addresses', ['ROWID'], {
    ROWID: 'id',
    address: 'id',
    business: 'id',
    category: 'number',
    last_modified: 'number',
    last_bcs_sync: 'time',
  }),
  businessCategories: table('business_categories', ['ROWID'], {
    ROWID: 'id',
    business: 'id',
    category: 'number',
  }),
  senders: table('senders', ['ROWID'], {
    ROWID: 'id',
    contact_identifier: 'text',
    bucket: 'number',
    user_initiated: 'number',
  }),
  senderAddresses: table('sender_addresses', ['address'], {
    address: 'id',
    sender: 'id',
  }),
  events: table('events', ['ROWID'], {
    ROWID: 'id',
    message_id: 'id',
    start_date: 'number',
    end_date: 'number',
    location: 'text',
    out_of_date: 'number',
    processed: 'number',
    is_all_day: 'number',
    associated_id_string: 'text',
    original_receiving_account: 'text',
    ical_uid: 'text',
    is_response_requested: 'number',
  }),
} as const;

export function mailStream(
  name: string,
  properties: Readonly<Record<string, FieldSchema>>,
  primaryKey: readonly string[],
  files: boolean,
): Stream {
  return new Stream({
    name,
    jsonSchema: {
      type: 'object',
      properties,
      required: Object.keys(properties),
    },
    primaryKey,
    supportedSyncModes: ['full_refresh', 'incremental'],
    sourceDefinedCursor: true,
    emitsDeletes: true,
    ...(files ? { supportsFileTransfer: true } : {}),
  });
}

export const tableStreams = Object.fromEntries(
  Object.entries(mailTables).map(([name, definition]) => [
    name,
    mailStream(name, definition.properties, definition.primaryKey, false),
  ]),
) as Record<keyof typeof mailTables, Stream>;
