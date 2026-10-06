import {
  type Attachment,
  type ChatDatabase,
  attachmentPath,
  attachmentTable,
} from '@workspace/sdk-apple-messages';
import { eventKitFields } from '@workspace/source-apple-macos/eventkit-fields';

import { AppleMessagesStream } from '../apple-messages-stream.ts';
import {
  localStore,
  provenance,
  tableFields,
  tableRecord,
} from '../messages-fields.ts';
import type { MessageSelection } from '../messages-scan.ts';

const properties = {
  guid: {
    ...eventKitFields.id,
    description:
      "chat.db attachment.guid; this stream's primary key. messageAttachments.attachmentGuid refers to it within this source.",
  },
  ...tableFields(attachmentTable, {
    filename: `${provenance(attachmentTable, 'filename')} The path Messages stores for the attachment's file, absolute or home-relative as ~/…; the file is exported from this path. A path does not prove the file exists: see availableLocally.`,
    sensitivity_analysis: `${provenance(attachmentTable, 'sensitivity_analysis')} Communication Safety's sensitivity analysis of the attachment, as Messages' own code records it beside whether the content is sensitive. Which value means what is not documented by Apple.`,
  }),
  // Changes when an offloaded file downloads, so the diff reloads its bytes.
  availableLocally: {
    ...eventKitFields.boolean,
    description:
      'Whether the file at filename, with ~/ expanded to the home directory, was accessible to the export when this record was read; false when filename is NULL or the path is not accessible, such as a file not downloaded to this Mac. File bytes are exported only when true.',
  },
};

export class AttachmentsStream extends AppleMessagesStream<Attachment> {
  readonly name = 'attachments';
  readonly primaryKey = ['guid'];
  readonly supportsFileTransfer = true;
  readonly jsonSchema = {
    type: 'object',
    description: `One record per attachment in chat.db's attachment table, keyed by guid; messageAttachments links attachments to messages, many-to-many. A record can exist without a readable file: availableLocally reports whether the stored filename was reachable when read, which changes, for example when an offloaded file downloads, independently of message and attachment dates. ${localStore}`,
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(database: ChatDatabase): readonly Attachment[] {
    return database.attachments();
  }

  protected accepts(
    attachment: Attachment,
    selection: MessageSelection,
  ): boolean {
    return selection.attachment(attachment.guid);
  }

  protected async records(
    attachment: Attachment,
  ): Promise<Record<string, unknown>[]> {
    return [
      {
        guid: attachment.guid,
        ...tableRecord(attachmentTable, attachment.values),
        availableLocally: await attachment.availableLocally(),
      },
    ];
  }

  // The original file, not a staged copy: attachments reach gigabytes and
  // readers only read it.
  override file({
    filename,
    availableLocally,
  }: Record<string, unknown>): string | null {
    return availableLocally === true && typeof filename === 'string'
      ? attachmentPath(filename)
      : null;
  }
}
