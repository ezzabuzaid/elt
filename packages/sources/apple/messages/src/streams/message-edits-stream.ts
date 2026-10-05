import type {
  ChatDatabase,
  MessageSummary,
} from '@workspace/sdk-apple-messages';
import { plistJSON } from '@workspace/sdk-apple-plist';
import { eventKitFields } from '@workspace/source-apple-macos/eventkit-fields';

import { AppleMessagesStream } from '../apple-messages-stream.ts';
import { localStore, messageGuid, unverified } from '../messages-fields.ts';
import type { MessageSelection } from '../messages-scan.ts';

const { integer, nullableTimestamp, nullableText, text } = eventKitFields;

const properties = {
  messageGuid,
  partIndex: {
    ...integer,
    description: `The "ec" key the entry is stored under, as a number, which the connector reads as the index of the edited message part. ${unverified}`,
  },
  version: {
    ...integer,
    description:
      "The entry's 0-based position in its part's stored list, in stored order.",
  },
  editedAt: {
    ...nullableTimestamp,
    description: `The entry's "d" time: a property list date, or nanoseconds, or seconds for magnitudes up to 10^11, since 2001-01-01 UTC, converted to a UTC instant; NULL when d is absent or not a time. Which moment it records is not documented by Apple.`,
  },
  text: {
    ...nullableText,
    description:
      'Plain text of the entry\'s "t" NSAttributedString archive in typedstream form, its first NSString; NULL when t is absent, not bytes or holds no string.',
  },
  entry: {
    ...text,
    description:
      'The whole entry as JSON, with "t" as Base64 and dates as ISO 8601; keeps the keys not extracted above.',
  },
};

// The versions of edited message parts, the current text included, from
// message_summary_info's "ec" (edited content): part index -> versions, each a
// date and an archived body.
export class MessageEditsStream extends AppleMessagesStream<MessageSummary> {
  readonly name = 'messageEdits';
  readonly primaryKey = ['messageGuid', 'partIndex', 'version'];
  readonly jsonSchema = {
    type: 'object',
    description: `One record per edit-history entry that chat.db message.message_summary_info stores under "ec", keyed by (messageGuid, partIndex, version); messageGuid refers to messages.guid. Messages without that history have no record; messages.messageSummaryInfo keeps the archive. ${localStore}`,
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(database: ChatDatabase): readonly MessageSummary[] {
    return database.summaries();
  }

  protected accepts(
    summary: MessageSummary,
    selection: MessageSelection,
  ): boolean {
    return selection.message(summary.messageGuid);
  }

  protected records(summary: MessageSummary): Record<string, unknown>[] {
    return summary.edits().map((edit) => ({
      messageGuid: summary.messageGuid,
      partIndex: edit.partIndex,
      version: edit.version,
      editedAt: edit.editedAt?.toISOString() ?? null,
      text: edit.text,
      entry: plistJSON(edit.entry),
    }));
  }
}
