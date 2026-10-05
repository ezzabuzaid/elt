import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  type PlistValue,
  decodeArchive,
  isBinaryPlist,
  isDictionary,
} from '@workspace/sdk-apple-plist';

import { attributedText } from './typedstream.ts';

export const appleEpoch = Date.UTC(2001, 0, 1);

// A blob from chat.db, decoded only when asked: many are NSKeyedArchiver
// property lists, and a row the reader skips is never decoded.
export class ChatData {
  readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  get archived(): boolean {
    return isBinaryPlist(this.bytes);
  }

  archive(): PlistValue {
    return decodeArchive(this.bytes);
  }
}

export type ChatValue = string | number | boolean | Date | ChatData | null;

// A row's exported columns by their chat.db names.
export type ChatValues = Readonly<Record<string, ChatValue>>;

// A handle as chat.db identifies it: the same id recurs once per service.
export type HandleKey = { readonly id: string; readonly service: string };

// Attachment filenames are stored absolute or home-relative, as
// ~/Library/Messages/Attachments/…
export const attachmentPath = (filename: string): string =>
  filename.startsWith('~/') ? join(homedir(), filename.slice(2)) : filename;

export class Message {
  readonly guid: string;
  // The handles message.handle_id and message.other_handle point to; null
  // when the ROWID matches no handle.
  readonly handle: HandleKey | null;
  readonly otherHandle: HandleKey | null;
  readonly values: ChatValues;

  constructor(
    guid: string,
    handle: HandleKey | null,
    otherHandle: HandleKey | null,
    values: ChatValues,
  ) {
    this.guid = guid;
    this.handle = handle;
    this.otherHandle = otherHandle;
    this.values = values;
  }

  // The message body: message.text, or when that is NULL the plain text of
  // the NSAttributedString archived in attributedBody, its first NSString.
  get text(): ChatValue {
    const stored = this.values.text ?? null;
    if (stored !== null) return stored;
    const body = this.values.attributedBody;
    return body instanceof ChatData ? attributedText(body.bytes) : null;
  }
}

export class Attachment {
  readonly guid: string;
  readonly values: ChatValues;

  constructor(guid: string, values: ChatValues) {
    this.guid = guid;
    this.values = values;
  }

  // Whether the stored filename is reachable now; false without a filename,
  // or for a file not downloaded to this Mac.
  async availableLocally(): Promise<boolean> {
    const { filename } = this.values;
    if (typeof filename !== 'string') return false;
    return access(attachmentPath(filename)).then(
      () => true,
      () => false,
    );
  }
}

// The rich link a URL message shows, from its payload_data archive. The
// fields follow Apple's LPLinkMetadata.
export type LinkPreview = {
  readonly url: string | null;
  readonly originalUrl: string | null;
  readonly title: string | null;
  readonly summary: string | null;
  readonly siteName: string | null;
  readonly itemType: string | null;
  readonly creator: string | null;
  // The whole unarchived richLinkMetadata object, its "$class" included.
  readonly metadata: PlistValue;
};

const textOf = (value: PlistValue | undefined) =>
  typeof value === 'string' ? value : null;

// A message's payload_data, decoded only when asked.
export class MessagePayload {
  readonly messageGuid: string;
  readonly #payload: unknown;

  constructor(messageGuid: string, payload: unknown) {
    this.messageGuid = messageGuid;
    this.#payload = payload;
  }

  linkPreview(): LinkPreview | null {
    if (!(this.#payload instanceof Uint8Array))
      throw new TypeError('chat.db message.payload_data is not a blob');
    const root = decodeArchive(this.#payload);
    const metadata = isDictionary(root) ? root.richLinkMetadata : undefined;
    if (!isDictionary(metadata)) return null;
    return {
      url: textOf(metadata.URL),
      originalUrl: textOf(metadata.originalURL),
      title: textOf(metadata.title),
      summary: textOf(metadata.summary),
      siteName: textOf(metadata.siteName),
      itemType: textOf(metadata.itemType),
      creator: textOf(metadata.creator),
      metadata,
    };
  }
}

// One version of an edited message part. A part's versions include its
// current text: on a live store (2026-10-05) the last was always the current
// text and no earlier one matched it.
export type MessageEdit = {
  // The "ec" key the entry is stored under, read as the part's index.
  readonly partIndex: number;
  // The entry's position in its part's stored list.
  readonly version: number;
  readonly editedAt: Date | null;
  // The plain text of its "t" NSAttributedString archive.
  readonly text: string | null;
  readonly entry: PlistValue;
};

// Messages writes edit times as it writes message dates: nanoseconds since
// 2001, or seconds in older formats, or a property list date.
function appleTime(value: PlistValue | undefined): Date | null {
  if (value instanceof Date) return value;
  if (typeof value !== 'number' && typeof value !== 'bigint') return null;
  const milliseconds =
    typeof value === 'bigint'
      ? Number(value / 1_000_000n)
      : Math.abs(value) > 100_000_000_000
        ? value / 1_000_000
        : value * 1000;
  return new Date(appleEpoch + Math.trunc(milliseconds));
}

// A message's message_summary_info, decoded only when asked. Its "ec"
// (edited content) maps a part index to the part's versions, each a date and
// an archived body.
export class MessageSummary {
  readonly messageGuid: string;
  readonly #summary: unknown;

  constructor(messageGuid: string, summary: unknown) {
    this.messageGuid = messageGuid;
    this.#summary = summary;
  }

  edits(): MessageEdit[] {
    if (!(this.#summary instanceof Uint8Array))
      throw new TypeError('chat.db message.message_summary_info is not a blob');
    const summary = decodeArchive(this.#summary);
    const edited = isDictionary(summary) ? summary.ec : undefined;
    if (!isDictionary(edited)) return [];
    return Object.entries(edited).flatMap(([part, versions]) =>
      (Array.isArray(versions) ? versions : []).map((entry, version) => {
        const body = isDictionary(entry) ? entry.t : undefined;
        return {
          partIndex: Number(part),
          version,
          editedAt: isDictionary(entry) ? appleTime(entry.d) : null,
          text: body instanceof Uint8Array ? attributedText(body) : null,
          entry,
        };
      }),
    );
  }
}
