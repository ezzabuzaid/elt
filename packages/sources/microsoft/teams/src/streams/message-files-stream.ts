import type { RecordDraft } from '@workspace/elt';
import type {
  TeamsMessage,
  TeamsMessageFile,
} from '@workspace/sdk-microsoft-teams';

import { teamsFields } from '../teams-stream.ts';
import {
  MessageChildStream,
  type Part,
  messageKey,
} from './message-child-stream.ts';

const { id, nullableText } = teamsFields;

const properties = {
  ...messageKey,
  fileId: { ...id, description: 'Teams’ ID for the file in the message.' },
  name: { ...nullableText, description: 'The file’s name.' },
  fileType: { ...nullableText, description: 'Its extension, such as pdf.' },
  title: { ...nullableText, description: 'The title the message shows.' },
  url: {
    ...nullableText,
    description:
      'Where the file is, in OneDrive or SharePoint; Teams keeps no copy on this Mac.',
  },
  siteUrl: {
    ...nullableText,
    description: 'The OneDrive or SharePoint site that holds it.',
  },
  shareUrl: { ...nullableText, description: 'A sharing link to it.' },
  service: {
    ...nullableText,
    description:
      'Where it lives: teams for a channel’s files, p2p for a chat’s, shared from the sender’s OneDrive.',
  },
} as const;

export class MessageFilesStream extends MessageChildStream<
  typeof properties,
  TeamsMessageFile
> {
  readonly name = 'messageFiles';
  readonly primaryKey = [
    'accountId',
    'conversationId',
    'threadId',
    'messageId',
    'fileId',
  ];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per file attached to a message; the file itself stays in OneDrive or SharePoint. Primary key accountId, conversationId, threadId, messageId, fileId. A file removed from a message the app still holds is deleted.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected children({ files }: TeamsMessage): readonly TeamsMessageFile[] {
    return files;
  }

  protected records({
    key,
    child: { id, ...file },
  }: Part<TeamsMessageFile>): RecordDraft<typeof properties>[] {
    return [{ ...key, fileId: id, ...file }];
  }
}
