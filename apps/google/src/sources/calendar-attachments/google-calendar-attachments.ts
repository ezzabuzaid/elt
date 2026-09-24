import { writeFile } from 'node:fs/promises';

import type { GoogleRequester } from 'google-auth';

import {
  isConfigurationError,
  statusOf,
} from '../../platform/google/google-errors.ts';

const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

// Structurally the attachment an Apple Calendar fetcher receives; this app does
// not import the Apple one.
export type CalendarAttachmentReference = { readonly uri: string };

type GoogleAttachment =
  | { readonly kind: 'drive'; readonly fileId: string }
  | { readonly kind: 'gmail'; readonly id: string; readonly partId: string };

/**
 * Downloads Calendar ATTACH references that point into Google: Drive files
 * (native Docs, Sheets and Slides exported as PDF) and Gmail message
 * attachments (Calendar stores them as `?view=att&th=…&attid=0.N`). Resolves
 * false for any other URL and for a file this account cannot open; a disabled
 * API, a missing scope or any other failure rejects.
 */
export function googleCalendarAttachments(requester: GoogleRequester) {
  return async (
    { uri }: CalendarAttachmentReference,
    path: string,
  ): Promise<boolean> => {
    const attachment = parseGoogleAttachment(uri);
    if (attachment === undefined) return false;
    let bytes: Uint8Array;
    try {
      bytes =
        attachment.kind === 'drive'
          ? await driveFile(requester, attachment.fileId)
          : await gmailAttachment(requester, attachment.id, attachment.partId);
    } catch (error) {
      const status = statusOf(error);
      if (status === 404 || (status === 403 && !isConfigurationError(error)))
        return false;
      throw error;
    }
    await writeFile(path, bytes);
    return true;
  };
}

export function parseGoogleAttachment(
  uri: string,
): GoogleAttachment | undefined {
  if (uri.startsWith('?')) {
    const query = new URLSearchParams(uri.slice(1));
    const id = query.get('th');
    const attid = query.get('attid');
    if (query.get('view') !== 'att' || !id || !attid?.startsWith('0.'))
      return undefined;
    // Gmail numbers attachments from the message root "0"; the API omits it.
    return { kind: 'gmail', id, partId: attid.slice(2) };
  }
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return undefined;
  }
  if (url.hostname !== 'drive.google.com' && url.hostname !== 'docs.google.com')
    return undefined;
  const fileId =
    /\/d\/([A-Za-z0-9_-]+)/.exec(url.pathname)?.[1] ??
    url.searchParams.get('id');
  return fileId ? { kind: 'drive', fileId } : undefined;
}

async function driveFile(
  requester: GoogleRequester,
  fileId: string,
): Promise<Uint8Array> {
  const file = encodeURIComponent(fileId);
  const metadata = await requester.request({
    url: `${DRIVE}/${file}?fields=mimeType&supportsAllDrives=true`,
  });
  const mimeType = field(metadata.data, 'mimeType');
  const response = await requester.request({
    url:
      typeof mimeType === 'string' &&
      mimeType.startsWith('application/vnd.google-apps.')
        ? `${DRIVE}/${file}/export?mimeType=application%2Fpdf`
        : `${DRIVE}/${file}?alt=media&supportsAllDrives=true`,
    responseType: 'arraybuffer',
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
