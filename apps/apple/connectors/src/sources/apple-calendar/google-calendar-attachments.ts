import { writeFile } from 'node:fs/promises';

import { type GoogleRequester, reasonsOf, statusOf } from 'google-auth';

import type { CalendarAttachmentFetcher } from './apple-calendar-source.ts';

const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

// 403 reasons that mean this account may not have the file. Any other 403
// (rate limits, a disabled API, a scope missing from the grant) rejects, so a
// throttled run fails instead of loading null bytes.
const NO_ACCESS = new Set([
  'forbidden',
  'insufficientFilePermissions',
  'appNotAuthorizedToFile',
  'domainPolicy',
  'cannotDownloadAbusiveFile',
  // Drive exports a Google Docs file only up to 10 MB, and exports no folder.
  'exportSizeLimitExceeded',
  'cannotExportFile',
]);

type DriveFile = { readonly fileId: string; readonly resourceKey?: string };

type GoogleAttachment =
  | ({ readonly kind: 'drive' } & DriveFile)
  | { readonly kind: 'gmail'; readonly id: string; readonly partId: string };

/**
 * Downloads Calendar ATTACH references that point into Google: Drive files
 * (native Docs, Sheets and Slides exported as PDF, shortcuts followed to their
 * target) and Gmail message attachments (Calendar stores them as
 * `?view=att&th=…&attid=0.N`). Resolves false for any other URL and for a file
 * this account cannot open; every other failure rejects.
 */
export function googleCalendarAttachments(
  requester: GoogleRequester,
): CalendarAttachmentFetcher {
  return async ({ uri }, path) => {
    const attachment = parseGoogleAttachment(uri);
    if (attachment === undefined) return false;
    let bytes: Uint8Array;
    try {
      bytes =
        attachment.kind === 'drive'
          ? await driveFile(requester, attachment)
          : await gmailAttachment(requester, attachment.id, attachment.partId);
    } catch (error) {
      const status = statusOf(error);
      if (
        status === 404 ||
        (status === 403 && reasonsOf(error).some((r) => NO_ACCESS.has(r)))
      )
        return false;
      throw error;
    }
    await writeFile(path, bytes);
    return true;
  };
}

function parseGoogleAttachment(uri: string): GoogleAttachment | undefined {
  if (uri.startsWith('?')) {
    const query = new URLSearchParams(uri.slice(1));
    const id = query.get('th');
    const attid = query.get('attid');
    if (query.get('view') !== 'att' || !id || !attid?.startsWith('0.'))
      return undefined;
    // Gmail numbers attachments from the message root "0"; the API omits it.
    return { kind: 'gmail', id, partId: attid.slice(2) };
  }
  if (!URL.canParse(uri)) return undefined;
  const url = new URL(uri);
  if (url.hostname !== 'drive.google.com' && url.hostname !== 'docs.google.com')
    return undefined;
  const fileId =
    /\/d\/([A-Za-z0-9_-]+)/.exec(url.pathname)?.[1] ??
    url.searchParams.get('id');
  if (!fileId) return undefined;
  // A link-shared file's URL carries the key Drive needs to open it.
  const resourceKey = url.searchParams.get('resourcekey');
  return { kind: 'drive', fileId, ...(resourceKey ? { resourceKey } : {}) };
}

async function driveFile(
  requester: GoogleRequester,
  { fileId, resourceKey }: DriveFile,
): Promise<Uint8Array> {
  const file = `${DRIVE}/${encodeURIComponent(fileId)}`;
  const headers = resourceKey
    ? { 'X-Goog-Drive-Resource-Keys': `${fileId}/${resourceKey}` }
    : undefined;
  const metadata = await requester.request({
    url: `${file}?fields=mimeType,shortcutDetails&supportsAllDrives=true`,
    ...(headers ? { headers } : {}),
  });
  const mimeType = field(metadata.data, 'mimeType');
  if (mimeType === 'application/vnd.google-apps.shortcut') {
    const shortcut = field(metadata.data, 'shortcutDetails');
    const targetId = field(shortcut, 'targetId');
    const targetKey = field(shortcut, 'targetResourceKey');
    if (typeof targetId !== 'string')
      throw new TypeError(`Drive shortcut ${fileId} has no target`);
    return driveFile(requester, {
      fileId: targetId,
      ...(typeof targetKey === 'string' ? { resourceKey: targetKey } : {}),
    });
  }
  const response = await requester.request({
    url:
      typeof mimeType === 'string' &&
      mimeType.startsWith('application/vnd.google-apps.')
        ? `${file}/export?mimeType=application%2Fpdf`
        : `${file}?alt=media&supportsAllDrives=true`,
    responseType: 'arraybuffer',
    ...(headers ? { headers } : {}),
  });
  if (!(response.data instanceof ArrayBuffer))
    throw new TypeError(`Drive returned no file content for ${fileId}`);
  return new Uint8Array(response.data);
}

async function gmailAttachment(
  requester: GoogleRequester,
  id: string,
  partId: string,
): Promise<Uint8Array> {
  const messages = await gmailMessages(requester, id);
  for (const message of messages) {
    const messageId = field(message, 'id');
    const part = findPart(field(message, 'payload'), partId);
    if (typeof messageId !== 'string' || part === undefined) continue;
    const body = field(part, 'body');
    const inline = field(body, 'data');
    if (typeof inline === 'string') return Buffer.from(inline, 'base64url');
    const attachmentId = field(body, 'attachmentId');
    if (typeof attachmentId !== 'string') continue;
    const attachment = await requester.request({
      url: `${GMAIL}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    });
    const data = field(attachment.data, 'data');
    if (typeof data !== 'string')
      throw new TypeError(`Gmail returned no attachment data for ${id}`);
    return Buffer.from(data, 'base64url');
  }
  throw Object.assign(
    new Error(`Gmail message ${id} has no attachment part ${partId}`),
    { status: 404 },
  );
}

// Calendar's `th` is usually a message id; fall back to a thread with that id.
async function gmailMessages(
  requester: GoogleRequester,
  id: string,
): Promise<unknown[]> {
  try {
    const message = await requester.request({
      url: `${GMAIL}/messages/${encodeURIComponent(id)}?format=full`,
    });
    return [message.data];
  } catch (error) {
    if (statusOf(error) !== 404) throw error;
    const thread = await requester.request({
      url: `${GMAIL}/threads/${encodeURIComponent(id)}?format=full`,
    });
    const messages = field(thread.data, 'messages');
    return Array.isArray(messages) ? messages : [];
  }
}

function findPart(part: unknown, partId: string): unknown {
  if (field(part, 'partId') === partId) return part;
  const children = field(part, 'parts');
  if (!Array.isArray(children)) return undefined;
  for (const child of children) {
    const match = findPart(child, partId);
    if (match !== undefined) return match;
  }
  return undefined;
}

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object'
    ? Reflect.get(value, key)
    : undefined;
}
