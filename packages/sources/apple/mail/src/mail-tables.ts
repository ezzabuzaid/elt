import { type FieldSchema, Stream } from '@workspace/elt';

type Kind = 'text' | 'number' | 'time' | 'base64' | 'id';

// Only confirmed Unix dates are converted. Unprobed native dates keep their raw
// numbers, with a Raw suffix, instead of guessing their epoch or sentinel values.
// Listed by name: a name pattern also matched events.out_of_date, not a date.
const rawDates = new Set([
  'due_by',
  'end_date',
  'follow_up_end_date',
  'follow_up_start_date',
  'last_modified',
  'read_later_date',
  'send_later_date',
  'smime_capabilities_date',
  'start_date',
]);
const rawDate = (column: string, kind: string) =>
  kind === 'number' && rawDates.has(column);

const fieldName = (column: string, kind: string) =>
  (column === 'ROWID'
    ? 'id'
    : column.replace(/_([a-z])/g, (_, letter: string) =>
        letter.toUpperCase(),
      )) + (kind === 'base64' ? 'Base64' : rawDate(column, kind) ? 'Raw' : '');

// Apple documents none of the Envelope Index. Every column states where its
// value comes from and how the SQL below converts it; only a meaning proven by
// the captured schema or this source's own joins replaces the unknown one.
const undocumented = 'Meaning not documented by Apple.';

function provenance(name: string, column: string, kind: Kind, key: boolean) {
  const value =
    column === 'ROWID'
      ? 'the local row identifier, loaded as decimal text'
      : {
          id: 'an integer loaded as decimal text to keep 64-bit precision',
          time: 'Unix seconds converted to a UTC timestamp with millisecond precision',
          base64:
            'BLOB bytes encoded as Base64; a stored text value passes through unchanged',
          text: 'text as stored',
          number: rawDate(column, kind)
            ? 'raw number as stored; its date epoch is unverified, so it is not converted'
            : 'number as stored',
        }[kind];
  return `Envelope Index ${name}.${column}, ${value}${key ? '' : '; NULL when the index stores no value'}.`;
}

function table<const Columns extends Readonly<Record<string, Kind>>>(
  name: string,
  description: string,
  keys: readonly string[],
  columns: Columns,
  meanings: { readonly [Column in keyof Columns]?: string },
) {
  const meaning: Readonly<Record<string, string | undefined>> = meanings;
  const properties: Record<string, FieldSchema> = {};
  const select: string[] = [];
  const blobs: string[] = [];
  for (const [column, kind] of Object.entries(columns)) {
    const field = fieldName(column, kind);
    const key = keys.includes(column);
    const scalar = kind === 'number' ? (key ? 'integer' : 'number') : 'string';
    properties[field] = {
      type: key ? scalar : [scalar, 'null'],
      ...(kind === 'time' ? { format: 'date-time' as const } : {}),
      description: `${provenance(name, column, kind, key)} ${meaning[column] ?? undocumented}`,
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
    description: `${description} Read from the Envelope Index ${name} table; index row identifiers are local to this Mac. Relationships name source streams within this source, not destination tables.`,
    columns: Object.keys(columns),
    properties,
    primaryKey: keys.map((key) => {
      const kind = columns[key];
      if (kind === undefined)
        throw new TypeError(`Mail table ${name} has no key column ${key}`);
      return fieldName(key, kind);
    }),
    blobs,
    sql: `SELECT ${select.join(', ')} FROM "${name}" ORDER BY ${keys.map((key) => `"${key}"`).join(', ')}`,
  };
}

// Captured schema only, no personal data. Indexing queues and transient sync
// actions stay internal; these are Mail's stored user data and relationships.
export const mailTables = {
  messages: table(
    'messages',
    'One record per message row in the local Mail index, across all accounts. Primary key id. Mailbox membership is its own grain: messageMailboxes holds message and mailbox pairs beside messages.mailbox and messages.remoteMailbox. subject, summary and sender hold identifiers that need explicit joins to subjects.id, summaries.id and addresses.id, and recipients are rows of recipients. The index declares no foreign keys for these references; they follow how this source reads the index, and a live store resolved every one. Bodies and headers are in messageParts and messageHeaders; whether the message file is on this Mac is in messageFiles.',
    ['ROWID'],
    {
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
    },
    {
      ROWID:
        'Local message identifier. messageMailboxes.messageId, recipients.message, indexedAttachments.message, serverMessages.message, messageReferences.message, events.messageId, messageFiles.messageId, messageHeaders.messageId, messageParts.messageId and attachments.messageId refer to it within this source.',
      message_id:
        "Hash Mail stores for the message's Message-ID, not this stream's id. conversationMessages.messageId and messageGlobalData.messageId hold the same hash within this source. It is not unique in the captured index schema, so a join on it can match several messages rows.",
      global_message_id:
        'Refers to messageGlobalData.id within this source; the captured index schema does not make it unique.',
      sender:
        'Refers to addresses.id within this source, which holds the address text.',
      subject:
        'Refers to subjects.id within this source, which holds the subject text.',
      summary:
        'Refers to summaries.id within this source, which holds the summary text.',
      mailbox:
        'Refers to mailboxes.id within this source. A message can belong to further mailboxes through messageMailboxes.',
      remote_mailbox: 'Refers to mailboxes.id within this source.',
      conversation_id: `${undocumented} This source relates messages to conversations through conversationMessages, not this column.`,
      brand_indicator: 'Refers to brandIndicators.id within this source.',
    },
  ),
  mailboxes: table(
    'mailboxes',
    'One record per mailbox row in the local Mail index, identified by its URL. Primary key id. Messages relate through messageMailboxes (many to many), messages.mailbox and messages.remoteMailbox; server messages through serverMessages.mailbox and serverMessageMailboxes.label. Count columns are passed through as stored, not recomputed from messages.',
    ['ROWID'],
    {
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
    {
      ROWID:
        'Local mailbox identifier. messageMailboxes.mailboxId, messages.mailbox, messages.remoteMailbox, serverMessages.mailbox and serverMessageMailboxes.label refer to it within this source.',
      url: 'Mailbox URL, unique in the captured index schema. Its host matches accounts.id within this source; accounts adds an On My Mac row for each local:// host that Mail scripting does not list.',
    },
  ),
  addresses: table(
    'addresses',
    'One record per distinct address and comment pair in the local Mail index; the captured index schema keeps each pair once. Primary key id. messages.sender, recipients.address, businessAddresses.address and senderAddresses.address refer to id; addressMetadata matches on the address text instead.',
    ['ROWID'],
    { ROWID: 'id', address: 'text', comment: 'text' },
    {
      ROWID:
        'Local address identifier. messages.sender, recipients.address, businessAddresses.address and senderAddresses.address refer to it within this source.',
      address:
        'Address text; the captured index schema compares it case-insensitively. addressMetadata.address holds the same text within this source.',
    },
  ),
  recipients: table(
    'recipients',
    'One record per address in one recipient position of one message. Primary key id. message refers to messages.id and address to addresses.id; the captured index schema keeps (message, type, position) unique and does not enforce message, so rows whose message is gone are kept. A message has many recipients: count messages at message grain (distinct message) after joining.',
    ['ROWID'],
    {
      ROWID: 'id',
      message: 'id',
      address: 'id',
      type: 'number',
      position: 'number',
    },
    {
      ROWID: 'Local recipient row identifier.',
      message:
        'Refers to messages.id within this source; not enforced by the index, so it can match no message.',
      address: 'Refers to addresses.id within this source.',
    },
  ),
  indexedAttachments: table(
    'attachments',
    'One record per attachment Mail records in its index for a message, which can exist before the message file or the attachment file is downloaded. Primary key id. message refers to messages.id; (message, attachmentId) matches (messageId, partId) in attachments and, once the message file is local, in messageParts. This stream carries no bytes or availability; the attachments stream does.',
    ['ROWID'],
    { ROWID: 'id', message: 'id', attachment_id: 'text', name: 'text' },
    {
      ROWID: 'Local index attachment row identifier.',
      message: 'Refers to messages.id within this source.',
      attachment_id:
        'MIME part number of the attachment, such as 2 or 1.2; equals partId in attachments and messageParts within this source.',
      name: 'Attachment name recorded by the index; attachments.filename uses it when the MIME part is not available locally.',
    },
  ),
  messageMailboxes: table(
    'labels',
    'One record per message and mailbox membership; a message can belong to several mailboxes. Primary key (messageId, mailboxId). messageId refers to messages.id and mailboxId to mailboxes.id. Joining messages through this stream repeats a message once per mailbox: count at message grain.',
    ['message_id', 'mailbox_id'],
    { message_id: 'id', mailbox_id: 'id' },
    {
      message_id:
        'Refers to messages.id within this source (the local id, not the hash in messages.messageId).',
      mailbox_id: 'Refers to mailboxes.id within this source.',
    },
  ),
  serverMessages: table(
    'server_messages',
    'One record per server message row, kept in a table separate from messages. Primary key id. message refers to messages.id and mailbox to mailboxes.id; (mailbox, remoteId) is unique in the captured index schema. Further mailbox memberships are in serverMessageMailboxes.',
    ['ROWID'],
    {
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
    {
      ROWID:
        'Local server message identifier; serverMessageMailboxes.serverMessage refers to it within this source.',
      message:
        'Refers to messages.id within this source; the index sets it to NULL when that message row is deleted.',
      mailbox: 'Refers to mailboxes.id within this source.',
      remote_id: `${undocumented} Unique together with mailbox in the captured index schema.`,
    },
  ),
  serverMessageMailboxes: table(
    'server_labels',
    'One record per server message and mailbox membership. Primary key (serverMessage, label). serverMessage refers to serverMessages.id and label to mailboxes.id. Joining through this stream repeats a server message once per mailbox: count at server message grain.',
    ['server_message', 'label'],
    { server_message: 'id', label: 'id' },
    {
      server_message: 'Refers to serverMessages.id within this source.',
      label: 'Refers to mailboxes.id within this source.',
    },
  ),
  conversations: table(
    'conversations',
    'One record per conversation row in the local Mail index. Primary key conversationId. Messages belong to conversations through conversationMessages.',
    ['conversation_id'],
    { conversation_id: 'id', flags: 'number', sync_key: 'text' },
    {
      conversation_id:
        'Local conversation identifier; conversationMessages.conversationId refers to it within this source.',
    },
  ),
  conversationMessages: table(
    'conversation_id_message_id',
    'One record per conversation and message membership. Primary key (conversationId, messageId). conversationId refers to conversations.conversationId; messageId is the Message-ID hash in messages.messageId, not messages.id. That hash is not unique in messages, so a join can match several messages rows: count at message grain.',
    ['conversation_id', 'message_id'],
    { conversation_id: 'id', message_id: 'id', date_sent: 'time' },
    {
      conversation_id:
        'Refers to conversations.conversationId within this source.',
      message_id:
        'Message-ID hash; matches messages.messageId within this source, not messages.id.',
    },
  ),
  messageReferences: table(
    'message_references',
    'One record per reference a message row carries. Primary key id. message refers to messages.id; reference is a Message-ID hash in the same space as messages.messageId and can match no messages row.',
    ['ROWID'],
    {
      ROWID: 'id',
      message: 'id',
      reference: 'id',
      is_originator: 'number',
    },
    {
      ROWID: 'Local message reference row identifier.',
      message: 'Refers to messages.id within this source.',
      reference:
        'Message-ID hash in the same space as messages.messageId within this source; not enforced by the index, so it can match no messages row.',
    },
  ),
  messageGlobalData: table(
    'message_global_data',
    'One record per message global data row in the local Mail index. Primary key id. messages.globalMessageId and messageRichLinks.globalMessageId refer to id; messageId holds the Message-ID hash of messages.messageId; generatedSummary refers to generatedSummaries.id. Raw-suffixed numbers keep their stored values because their date epoch is unverified.',
    ['ROWID'],
    {
      ROWID: 'id',
      message_id: 'id',
      follow_up_start_date: 'number',
      follow_up_end_date: 'number',
      follow_up_jsonstringformodelevaluationforsuggestions: 'text',
      due_by: 'number',
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
    },
    {
      ROWID:
        'Local identifier; messages.globalMessageId and messageRichLinks.globalMessageId refer to it within this source.',
      message_id:
        'Message-ID hash, the same value as messages.messageId within this source; unique in the captured index schema.',
      generated_summary: 'Refers to generatedSummaries.id within this source.',
    },
  ),
  subjects: table(
    'subjects',
    "One record per distinct subject text in the local Mail index; the captured index schema stores each text once. Primary key id. messages.subject refers to id: join from messages to read a message's subject.",
    ['ROWID'],
    { ROWID: 'id', subject: 'text' },
    {
      ROWID:
        'Local subject identifier; messages.subject refers to it within this source.',
      subject:
        'Subject text Mail stores for its messages, passed through as collected.',
    },
  ),
  summaries: table(
    'summaries',
    "One record per distinct summary text in the local Mail index; the captured index schema stores each text once. Primary key id. messages.summary refers to id: join from messages to read a message's summary.",
    ['ROWID'],
    { ROWID: 'id', summary: 'text' },
    {
      ROWID:
        'Local summary identifier; messages.summary refers to it within this source.',
      summary:
        'Summary text Mail already stores, passed through as collected; this connector generates no summaries.',
    },
  ),
  generatedSummaries: table(
    'generated_summaries',
    'One record per generated summary row in the local Mail index. Primary key id. messageGlobalData.generatedSummary refers to id. The summary is a binary payload exported as Base64 without decoding.',
    ['ROWID'],
    { ROWID: 'id', summary: 'base64', status: 'number' },
    {
      ROWID:
        'Local generated summary identifier; messageGlobalData.generatedSummary refers to it within this source.',
      summary: `${undocumented} Mail's stored payload; this connector does not decode it.`,
    },
  ),
  messageMetadata: table(
    'message_metadata',
    'One record per message metadata row in the local Mail index. Primary key messageId. The source proves no owning message for these rows, so no join is stated and scoped imports omit this stream. jsonValues is native JSON text passed through as data.',
    ['message_id'],
    { message_id: 'id', timestamp: 'number', json_values: 'text' },
    {
      message_id: `${undocumented} Not proven to refer to messages.id or messages.messageId, so no join is stated.`,
      json_values: `${undocumented} Native JSON text passed through without interpretation.`,
    },
  ),
  dataDetectionResults: table(
    'data_detection_results',
    'One record per detection result row in the local Mail index: a category and value. Primary key id. (globalMessageId, category, value) is unique in the captured index schema. The source proves no owning message for these rows, so no join is stated and scoped imports omit this stream.',
    ['ROWID'],
    {
      ROWID: 'id',
      global_message_id: 'id',
      category: 'text',
      value: 'text',
    },
    {
      ROWID: 'Local detection result row identifier.',
      global_message_id: `${undocumented} Not proven to refer to messageGlobalData.id, so no join is stated.`,
    },
  ),
  richLinks: table(
    'rich_links',
    'One record per rich link row in the local Mail index. Primary key id. messageRichLinks.richLink refers to id; hash is unique in the captured index schema.',
    ['ROWID'],
    { ROWID: 'id', title: 'text', url: 'text', hash: 'text' },
    {
      ROWID:
        'Local rich link identifier; messageRichLinks.richLink refers to it within this source.',
      hash: `${undocumented} Unique in the captured index schema.`,
    },
  ),
  messageRichLinks: table(
    'message_rich_links',
    'One record per message global data row and rich link pair. Primary key (globalMessageId, richLink). globalMessageId refers to messageGlobalData.id, reached from messages through messages.globalMessageId; richLink refers to richLinks.id. A message can have several links: count at message grain.',
    ['global_message_id', 'rich_link'],
    { global_message_id: 'id', rich_link: 'id' },
    {
      global_message_id: 'Refers to messageGlobalData.id within this source.',
      rich_link: 'Refers to richLinks.id within this source.',
    },
  ),
  protectedMessageData: table(
    'protected_message_data',
    'One record per protected message data row in the local Mail index. Primary key id. data is an opaque native payload passed through as text. The source proves no owning message for these rows, so no join is stated and scoped imports omit this stream.',
    ['ROWID'],
    { ROWID: 'id', data: 'text' },
    {
      ROWID: `${undocumented} Not proven to refer to any other stream, so no join is stated.`,
      data: `${undocumented} Opaque native payload passed through without interpretation.`,
    },
  ),
  brandIndicators: table(
    'brand_indicators',
    'One record per brand indicator row in the local Mail index. Primary key id. messages.brandIndicator and brandIndicatorEvidence.brandIndicator refer to id; url is unique in the captured index schema. indicator is binary, exported as Base64 without decoding.',
    ['ROWID'],
    {
      ROWID: 'id',
      url: 'text',
      indicator: 'base64',
      indicator_hash: 'text',
      hash_algorithm: 'text',
    },
    {
      ROWID:
        'Local brand indicator identifier; messages.brandIndicator and brandIndicatorEvidence.brandIndicator refer to it within this source.',
      url: `${undocumented} Unique in the captured index schema.`,
    },
  ),
  brandIndicatorEvidence: table(
    'brand_indicator_evidence',
    'One record per brand indicator evidence row in the local Mail index. Primary key id. brandIndicator refers to brandIndicators.id; (brandIndicator, url) is unique in the captured index schema. evidence is binary, exported as Base64 without decoding.',
    ['ROWID'],
    {
      ROWID: 'id',
      brand_indicator: 'id',
      url: 'text',
      evidence: 'base64',
      unverified_messages: 'text',
    },
    {
      ROWID: 'Local brand indicator evidence row identifier.',
      brand_indicator: 'Refers to brandIndicators.id within this source.',
    },
  ),
  addressMetadata: table(
    'address_metadata',
    'One record per address metadata row in the local Mail index. Primary key id. address holds address text, unique in the captured index schema, and matches addresses.address, not addresses.id.',
    ['ROWID'],
    {
      ROWID: 'id',
      address: 'text',
      smime_capabilities: 'text',
      smime_capabilities_date: 'number',
    },
    {
      ROWID: 'Local address metadata row identifier.',
      address:
        'Address text matching addresses.address within this source; the captured index schema compares both case-insensitively.',
    },
  ),
  businesses: table(
    'businesses',
    'One record per business row in the local Mail index. Primary key id. businessAddresses.business and businessCategories.business refer to id. The captured index schema requires each row to hold either addressComment and domain, or brandId and localizedBrandName, and leaves the other pair NULL.',
    ['ROWID'],
    {
      ROWID: 'id',
      address_comment: 'text',
      domain: 'text',
      brand_id: 'id',
      localized_brand_name: 'text',
    },
    {
      ROWID:
        'Local business identifier; businessAddresses.business and businessCategories.business refer to it within this source.',
    },
  ),
  businessAddresses: table(
    'business_addresses',
    'One record per address assigned to a business. Primary key id. address refers to addresses.id, unique in the captured index schema, and business refers to businesses.id.',
    ['ROWID'],
    {
      ROWID: 'id',
      address: 'id',
      business: 'id',
      category: 'number',
      last_modified: 'number',
      last_bcs_sync: 'time',
    },
    {
      ROWID: 'Local business address row identifier.',
      address:
        'Refers to addresses.id within this source; unique in the captured index schema.',
      business: 'Refers to businesses.id within this source.',
    },
  ),
  businessCategories: table(
    'business_categories',
    'One record per business category row in the local Mail index. Primary key id. business refers to businesses.id and is unique in the captured index schema.',
    ['ROWID'],
    { ROWID: 'id', business: 'id', category: 'number' },
    {
      ROWID: 'Local business category row identifier.',
      business:
        'Refers to businesses.id within this source; unique in the captured index schema.',
    },
  ),
  senders: table(
    'senders',
    'One record per sender row in the local Mail index. Primary key id. senderAddresses.sender refers to id; contactIdentifier is unique in the captured index schema.',
    ['ROWID'],
    {
      ROWID: 'id',
      contact_identifier: 'text',
      bucket: 'number',
      user_initiated: 'number',
    },
    {
      ROWID:
        'Local sender identifier; senderAddresses.sender refers to it within this source.',
      contact_identifier: `${undocumented} Unique in the captured index schema.`,
    },
  ),
  senderAddresses: table(
    'sender_addresses',
    'One record per address assigned to a sender. Primary key address. address refers to addresses.id and sender to senders.id; each address has at most one sender.',
    ['address'],
    { address: 'id', sender: 'id' },
    {
      address: 'Refers to addresses.id within this source.',
      sender: 'Refers to senders.id within this source.',
    },
  ),
  events: table(
    'events',
    'One record per event row the local Mail index stores for a message. Primary key id. messageId refers to messages.id, the local id, not the Message-ID hash. startDateRaw and endDateRaw keep stored numbers because their date epoch is unverified.',
    ['ROWID'],
    {
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
    },
    {
      ROWID: 'Local event row identifier.',
      message_id:
        'Refers to messages.id within this source (the local id, not messages.messageId).',
    },
  ),
} as const;

export function mailStream(
  name: string,
  description: string,
  properties: Readonly<Record<string, FieldSchema>>,
  primaryKey: readonly string[],
  files: boolean,
): Stream {
  return new Stream({
    name,
    jsonSchema: {
      type: 'object',
      description,
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

export const tableStreams = Object.entries(mailTables).map(
  ([name, definition]) =>
    mailStream(
      name,
      definition.description,
      definition.properties,
      definition.primaryKey,
      false,
    ),
);
