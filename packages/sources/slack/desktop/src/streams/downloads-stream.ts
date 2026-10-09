import { statSync } from 'node:fs';

import type { RecordDraft, SchemaRecord } from '@workspace/elt';
import type { SlackDownload } from '@workspace/sdk-slack-desktop';

import type { SlackDesktopScan } from '../slack-desktop-scan.ts';
import { SlackDesktopStream, slackFields } from '../slack-desktop-stream.ts';

const { id, nullableText, nullableNumber, nullableTimestamp } = slackFields;

const properties = {
  workspaceId: { ...id, description: 'The workspace (workspaces.id).' },
  fileId: {
    ...id,
    description: 'The file downloaded (files.id), held by the app or not.',
  },
  url: {
    ...nullableText,
    description:
      'Where the app downloaded it from, which needs Slack’s sign-in.',
  },
  userId: { ...nullableText, description: 'Who downloaded it (members.id).' },
  appVersion: {
    ...nullableText,
    description: 'The Slack app’s version when it downloaded the file.',
  },
  state: {
    ...nullableText,
    description: 'Slack’s state for the download, such as completed.',
  },
  progress: {
    ...nullableNumber,
    description: 'How much of the file had downloaded, 1 when done.',
  },
  startedAt: {
    ...nullableTimestamp,
    description: 'When the download started.',
  },
  endedAt: { ...nullableTimestamp, description: 'When it finished.' },
  path: {
    ...nullableText,
    description:
      'Where the app saved the file: its Downloads folder, ~/Library/Containers/com.tinyspeck.slackmacgap/Data/Downloads, unless the user chose another place.',
  },
} as const;

// The app keeps each download until the user clears its list, which removes
// the entry, not the file: the stream keeps every row it loaded.
export class DownloadsStream extends SlackDesktopStream<
  typeof properties,
  SlackDownload
> {
  readonly name = 'downloads';
  readonly primaryKey = ['workspaceId', 'fileId'];
  override readonly emitsDeletes = undefined;
  readonly supportsFileTransfer = true;
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per file the Slack app downloaded, with the file while it is still where the app saved it. Primary key workspaceId, fileId. A download stays after the user clears Slack’s list of downloads.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: SlackDesktopScan): readonly SlackDownload[] {
    return scan.downloads;
  }

  protected records(download: SlackDownload): RecordDraft<typeof properties>[] {
    return [{ ...download }];
  }

  // The original file, not a copy: downloads reach gigabytes and readers
  // only read it. One moved, deleted or out of this process's reach loads
  // no bytes.
  override file({ path }: SchemaRecord<typeof properties>): string | null {
    if (path === null) return null;
    try {
      return statSync(path).isFile() ? path : null;
    } catch {
      return null;
    }
  }
}
