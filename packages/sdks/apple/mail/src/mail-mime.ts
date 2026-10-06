import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, open, rm } from 'node:fs/promises';
import { basename } from 'node:path';
import type { Transform } from 'node:stream';
import { pipeline, finished as streamFinished } from 'node:stream/promises';

import {
  type MimeNode,
  Splitter,
  type SplitterChunk,
} from '@zone-eu/mailsplit';
import libmime from 'libmime';

import { MailSchemaError } from './errors.ts';
import type { MailFile, MailFiles } from './mail-files.ts';

// One MIME part of a message file. A value the MIME parser reports absent is
// null.
export type MimePart = {
  // Dotted MIME part number, such as 1 or 1.2. The root of a multipart message
  // is TEXT; a single-part message is 1, as Mail's index numbers it.
  readonly id: string;
  readonly parentId: string | null;
  readonly contentType: string | null;
  readonly charset: string | null;
  readonly transferEncoding: string | null;
  readonly disposition: string | null;
  readonly filename: string | null;
  readonly contentId: string | null;
  readonly isMultipart: boolean;
  // A non-multipart part with a filename, an attachment disposition, an
  // attached message or a media type other than text/*.
  readonly isAttachment: boolean;
  // X-Apple-Content-Length: the size of a part Mail downloads apart from its
  // message, whose body in the message file is then empty.
  readonly declaredBytes: number | null;
  // After transfer decoding, or the size of the separate file of a detached
  // part; null for a container, a part not decoded, or a detached part whose
  // file is missing.
  readonly decodedBytes: number | null;
  // False only for a detached part whose separate file is missing.
  readonly availableLocally: boolean;
  readonly sha256: string | null;
  // The decoded bytes, staged where the caller asked.
  readonly file: string | null;
  // A text/* part decoded with its charset, when nothing is staged.
  readonly text: string | null;
};

type MimeHeader = {
  readonly partId: string;
  // Within the part's header block, in stored order.
  readonly position: number;
  // As the MIME parser keys it, in lowercase.
  readonly name: string;
  // Folded lines joined and encoded words decoded.
  readonly value: string;
  // The whole header line, folded continuation lines joined with CRLF.
  readonly rawLine: Uint8Array;
};

type Part = { -readonly [Key in keyof MimePart]: MimePart[Key] };

const failure = (error: unknown) =>
  Error.isError(error) ? error : new Error(String(error), { cause: error });

function partId(node: MimeNode): string {
  if (node.partNr === false)
    throw new MailSchemaError('MIME parser returned an unresolved part number');
  // Apple numbers a single-part message's attachment as 1, even before its
  // MIME file arrives. Keep that key when Splitter calls the root TEXT.
  if (
    node.multipart === false &&
    node.partNr.length === 1 &&
    node.partNr[0] === 'TEXT'
  )
    return '1';
  return node.partNr.join('.');
}

// Splitter owns MIME structure, encoded headers, filenames and transfer decoding.
// This function only owns Apple's byte frame and separately downloaded files.
// It reads either the headers of every part, or the parts, decoding those
// decode() selects: staged to the file stage() names, or, when stage is null,
// as text for text/* parts.
export async function readMailMime(
  files: MailFiles,
  messageId: string,
  file: MailFile,
  {
    headers: readHeaders,
    decode,
    stage,
  }: {
    readonly headers: boolean;
    readonly decode: (part: MimePart) => boolean;
    readonly stage: ((part: MimePart) => string) | null;
  },
): Promise<{ headers: MimeHeader[]; parts: MimePart[] }> {
  await file.assertUnchanged();
  await using handle = await open(file.path, 'r');
  const prefix = Buffer.alloc(64);
  const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
  const line = /^(\d+)[ \t]*\r?\n/.exec(
    prefix.subarray(0, bytesRead).toString('ascii'),
  );
  if (line === null)
    throw new MailSchemaError(
      `Invalid EMLX byte count for message ${messageId}`,
    );
  const length = Number(line[1]);
  const start = Buffer.byteLength(line[0]);
  if (!Number.isSafeInteger(length) || length < 1 || start + length > file.size)
    throw new MailSchemaError(`Truncated EMLX message ${messageId}`);

  const headers: MimeHeader[] = [];
  const parts: Part[] = [];
  const splitter = new Splitter({ ignoreEmbedded: true });
  // The official option preserves an attached message/rfc822 as its complete
  // decoded file. Expanding it in Splitter would consume its attachment bytes.
  const input = pipeline(
    handle.createReadStream({
      start,
      end: start + length - 1,
      autoClose: false,
    }),
    splitter,
  );
  input.catch(() => {}); // Observed below; do not leave a rejection unhandled while consuming.
  let active: {
    decoder: Transform;
    finished: Promise<void>;
    part: Part;
    hash: ReturnType<typeof createHash>;
    textDecoder: TextDecoder | null;
  } | null = null;

  const finish = async () => {
    if (active === null) return;
    const { decoder, finished, part, hash, textDecoder } = active;
    active = null;
    decoder.end();
    await finished;
    if (textDecoder !== null) part.text += textDecoder.decode();
    if (
      part.decodedBytes === 0 &&
      part.declaredBytes !== null &&
      part.declaredBytes > 0
    ) {
      const diskId = part.id;
      const candidates = files.attachments.get(`${messageId}:${diskId}`);
      if (candidates === undefined) {
        part.availableLocally = false;
        part.decodedBytes = null;
        if (part.file !== null) await rm(part.file);
        part.file = null;
        part.text = null;
        return;
      }
      const matches =
        candidates.length === 1
          ? candidates
          : candidates.filter(
              (candidate) => basename(candidate.path) === part.filename,
            );
      const [original] = matches;
      if (original === undefined || matches.length !== 1)
        throw new MailSchemaError(
          `Ambiguous detached Mail attachment ${messageId}:${diskId}`,
        );
      await original.assertUnchanged();
      if (part.file !== null) await copyFile(original.path, part.file);
      if (textDecoder !== null)
        part.text = await mailPartText(original.path, textDecoder);
      await original.assertUnchanged();
      part.decodedBytes = original.size;
      part.sha256 = await original.hash();
    } else {
      part.sha256 = hash.digest('hex');
    }
  };

  const chunks: AsyncIterable<SplitterChunk> = splitter;
  try {
    for await (const chunk of chunks) {
      if (chunk.type === 'node') {
        await finish();
        const node = chunk;
        if (node.headers === false)
          throw new MailSchemaError('MIME parser returned no headers');
        const id = partId(node);
        if (readHeaders)
          for (const [position, header] of node.headers.getList().entries()) {
            const decoded = libmime.decodeHeader(
              Buffer.from(header.line, 'latin1').toString('utf8'),
            );
            headers.push({
              partId: id,
              position,
              name: header.key,
              value: libmime.decodeWords(decoded.value),
              rawLine: Buffer.from(header.line, 'latin1'),
            });
          }
        if (readHeaders) continue;
        const appleLength = node.headers.getFirst('X-Apple-Content-Length');
        if (
          appleLength !== '' &&
          (!/^\d+$/.test(appleLength) ||
            !Number.isSafeInteger(Number(appleLength)))
        )
          throw new MailSchemaError(
            `Invalid detached MIME size in message ${messageId}`,
          );
        const contentId = node.headers.getFirst('Content-ID');
        // MimeNode.parseHeaders explicitly uses false for absent optional fields;
        // Headers.getFirst explicitly returns '' when a header is absent.
        const part: Part = {
          id,
          parentId: node.parentNode === false ? null : partId(node.parentNode),
          contentType: node.contentType === false ? null : node.contentType,
          charset: node.charset === false ? null : node.charset,
          transferEncoding:
            node.encoding === false || node.encoding === ''
              ? null
              : node.encoding,
          disposition: node.disposition === false ? null : node.disposition,
          filename: node.filename === false ? null : node.filename,
          contentId: contentId === '' ? null : contentId,
          isMultipart: node.multipart !== false,
          isAttachment:
            node.multipart === false &&
            (node.filename !== false ||
              node.disposition === 'attachment' ||
              node.rfc822 ||
              (node.contentType !== false &&
                !node.contentType.startsWith('text/'))),
          declaredBytes: appleLength === '' ? null : Number(appleLength),
          decodedBytes: null,
          availableLocally: true,
          sha256: null,
          file: null,
          text: null,
        };
        parts.push(part);
        if (node.multipart !== false || !decode(part)) continue;
        if (stage !== null) part.file = stage(part);
        const decoder = node.getDecoder();
        const hash = createHash('sha256');
        // Missing charset is MimeNode's documented false value; TextDecoder
        // owns the default. Keep text only when the caller requested bodies.
        const textDecoder =
          stage === null &&
          part.contentType !== null &&
          part.contentType.startsWith('text/')
            ? new TextDecoder(part.charset === null ? undefined : part.charset)
            : null;
        if (textDecoder !== null) part.text = '';
        part.decodedBytes = 0;
        decoder.on('data', (bytes: Buffer) => {
          hash.update(bytes);
          part.decodedBytes = (part.decodedBytes ?? 0) + bytes.length;
          if (textDecoder !== null)
            part.text += textDecoder.decode(bytes, { stream: true });
        });
        const finished =
          part.file === null
            ? streamFinished(decoder, { cleanup: true })
            : pipeline(decoder, createWriteStream(part.file, { flags: 'wx' }));
        finished.catch((error: unknown) => splitter.destroy(failure(error)));
        active = { decoder, finished, part, hash, textDecoder };
      } else if (chunk.type === 'body' && active !== null) {
        if (!active.decoder.write(chunk.value))
          await once(active.decoder, 'drain');
      }
    }
    await finish();
    await input;
    await file.assertUnchanged();
    return { headers, parts };
  } catch (error) {
    const reason = failure(error);
    splitter.destroy(reason);
    if (active !== null) active.decoder.destroy(reason);
    await input.catch(() => {});
    if (active !== null) await active.finished.catch(() => {});
    await Promise.allSettled(
      parts.flatMap((part) => (part.file === null ? [] : [rm(part.file)])),
    );
    throw error;
  }
}

async function mailPartText(
  path: string,
  decoder: TextDecoder,
): Promise<string> {
  let text = '';
  for await (const bytes of createReadStream(path))
    text += decoder.decode(bytes, { stream: true });
  return text + decoder.decode();
}
