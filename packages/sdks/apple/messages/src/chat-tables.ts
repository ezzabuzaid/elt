// How chat.db stores a column's values. text is never NULL; nullableText,
// integer, flag, time and data can be. A flag is Messages' 0/1 integer; a time
// counts nanoseconds (seconds in older rows) since 2001-01-01 UTC; data is a
// blob, often an archived property list.
export type ChatColumnKind =
  'text' | 'nullableText' | 'integer' | 'flag' | 'time' | 'data';

// A chat.db table: the columns a reader exports, grouped by kind in the order
// they load, and the columns it reads only to join, such as ROWID and the
// foreign keys a GUID resolves through.
export type ChatTable = {
  readonly name: string;
  readonly joins: readonly string[];
  readonly columns: Readonly<Record<string, ChatColumnKind>>;
};

const order: readonly ChatColumnKind[] = [
  'text',
  'nullableText',
  'integer',
  'flag',
  'time',
  'data',
];

function table(
  name: string,
  joins: readonly string[],
  lists: Partial<Record<ChatColumnKind, string>>,
): ChatTable {
  const columns: Record<string, ChatColumnKind> = {};
  for (const kind of order)
    for (const column of (lists[kind] ?? '').split(/\s+/).filter(Boolean))
      columns[column] = kind;
  return { name, joins, columns };
}

// iCloud sync bookkeeping (deleted_messages, sync_deleted_*) is not read.
export const messageTable = table(
  'message',
  ['ROWID', 'guid', 'handle_id', 'other_handle'],
  {
    nullableText:
      'text subject service_center country service account account_guid cache_roomnames group_title associated_message_guid balloon_bundle_id expressive_send_style_id ck_record_id ck_record_change_tag destination_caller_id reply_to_guid thread_originator_guid thread_originator_part syndication_ranges synced_syndication_ranges bia_reference_id fallback_hash associated_message_emoji ck_chat_id',
    integer:
      'replace version type error item_type group_action_type share_status share_direction expire_state message_action_type message_source associated_message_type associated_message_range_location associated_message_range_length ck_sync_state sort_id part_count schedule_type schedule_state index_state filter_action filter_sub_action retry_count',
    flag: 'is_delivered is_finished is_emote is_from_me is_empty is_delayed is_auto_reply is_prepared is_read is_system_message is_sent has_dd_results is_service_message is_forward was_downgraded is_archive cache_has_attachments was_data_detected was_deduplicated is_audio_message is_played is_expirable is_corrupt is_spam has_unseen_mention was_delivered_quietly did_notify_recipient was_detonated is_stewie is_sos is_critical is_kt_verified is_pending_satellite_send needs_relay sent_or_received_off_grid is_time_sensitive is_preview_sent is_preview_delivered',
    time: 'date date_read date_delivered date_played time_expressive_send_played date_retracted date_edited date_recovered date_preview_sent date_preview_delivered date_updated',
    data: 'attributedBody payload_data message_summary_info',
  },
);

export const chatTable = table('chat', ['ROWID', 'guid'], {
  nullableText:
    'chat_identifier service_name room_name account_id account_login last_addressed_handle display_name group_id engram_id server_change_token original_group_id cloudkit_record_id last_addressed_sim_id',
  integer: 'style state successful_query ck_sync_state syndication_type',
  flag: 'is_archived is_filtered is_blackholed is_recovered is_deleting_incoming_messages is_pending_review',
  time: 'last_read_message_timestamp syndication_date',
  data: 'properties',
});

export const handleTable = table('handle', ['ROWID'], {
  text: 'id service',
  nullableText: 'country uncanonicalized_id person_centric_id',
});

export const attachmentTable = table('attachment', ['ROWID', 'guid'], {
  text: 'original_guid',
  nullableText:
    'filename uti mime_type transfer_name ck_record_id emoji_image_content_identifier emoji_image_short_description',
  integer:
    'transfer_state total_bytes ck_sync_state preview_generation_state sensitivity_analysis',
  flag: 'is_outgoing is_sticker hide_attachment is_commsafety_sensitive',
  time: 'created_date start_date',
  data: 'user_info sticker_user_info attribution_info ck_server_change_token_blob preflight_info',
});

export const chatLookupTable = table('chat_lookup', ['chat'], {
  text: 'identifier domain',
  integer: 'priority',
});

export const chatServiceTable = table('chat_service', ['chat'], {
  text: 'service',
});

export const chatHandleTable = table(
  'chat_handle_join',
  ['chat_id', 'handle_id'],
  {},
);

export const chatMessageTable = table(
  'chat_message_join',
  ['chat_id', 'message_id'],
  {
    integer: 'index_state filter_action filter_sub_action',
    time: 'message_date',
  },
);

export const recoverableMessageTable = table(
  'chat_recoverable_message_join',
  ['chat_id', 'message_id'],
  { integer: 'ck_sync_state', time: 'delete_date' },
);

// part_index is part of the row's identity, so it is read as a join column.
export const recoverablePartTable = table(
  'recoverable_message_part',
  ['chat_id', 'message_id', 'part_index'],
  { integer: 'ck_sync_state', time: 'delete_date', data: 'part_text' },
);

export const messageAttachmentTable = table(
  'message_attachment_join',
  ['message_id', 'attachment_id'],
  {},
);

export const chatTables: readonly ChatTable[] = [
  messageTable,
  chatTable,
  handleTable,
  attachmentTable,
  chatLookupTable,
  chatServiceTable,
  chatHandleTable,
  chatMessageTable,
  recoverableMessageTable,
  recoverablePartTable,
  messageAttachmentTable,
];
