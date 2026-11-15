import type { RecordDraft } from '@eltjs/elt';
import type {
  TeamsMessage,
  TeamsMessageFile,
} from '@eltjs/sdk-microsoft-teams';

import { teamsFields } from '../teams-stream.ts';
import {
  MessageChildStream,
  type Part,
  messageKey,
  messagePlaceKey,
} from './message-child-stream.ts';

const { id, position, nullableText } = teamsFields;

const properties = {
  ...messageKey,
  position: {
    ...position,
    description:
      'The file’s place among the message’s files, from 0: Teams can list one file several times.',
  },
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
  readonly primaryKey = [...messagePlaceKey, 'position'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per file attached to a message; the file itself stays in OneDrive or SharePoint. Primary key accountId, store, conversationId, recordId, entry (its message’s place) and position. A file removed from a message the app still holds is deleted.',
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
