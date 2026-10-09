import { Fields } from './fields.ts';
import { milliseconds } from './instants.ts';

// A file the app downloaded for a workspace, as its main process records it.
// The file is wherever the user saved it, the app's Downloads folder unless
// they chose another.
export type SlackDownload = {
  readonly workspaceId: string;
  // Slack's file ID (SlackFile.id).
  readonly fileId: string;
  readonly url: string | null;
  readonly userId: string | null;
  // The app's version when it downloaded the file.
  readonly appVersion: string | null;
  // Slack's state for the download, such as completed.
  readonly state: string | null;
  // How much had downloaded, 1 when done.
  readonly progress: number | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly path: string | null;
};

// The app's own state as its main process saves it: downloads by workspace,
// then by file, beside settings this reader does not read.
export function readSlackDownloads(
  state: unknown,
  record: string,
): SlackDownload[] {
  const root = new Fields(state, record, 'state');
  const byWorkspace = root.object('downloads');
  return root.values('downloads').flatMap(([workspaceId]) =>
    (byWorkspace?.entries(workspaceId) ?? []).map(([fileId, download]) => ({
      workspaceId,
      fileId,
      url: download.string('url'),
      userId: download.string('userId'),
      appVersion: download.string('appVersion'),
      state: download.string('downloadState'),
      progress: download.number('progress'),
      startedAt: milliseconds(download.number('startTime')),
      endedAt: milliseconds(download.number('endTime')),
      path: download.string('downloadPath'),
    })),
  );
}
