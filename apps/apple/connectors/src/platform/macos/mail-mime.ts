import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, open, rm } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { Transform } from 'node:stream';
import { pipeline, finished as streamFinished } from 'node:stream/promises';
import {
  type MimeNode,
  Splitter,
  type SplitterChunk,
} from '@zone-eu/mailsplit';
import libmime from 'libmime';
import {
  assertMailFile,
  hashMailFile,
  type MailFile,
  MailSchemaError,
  type MailStore,
} from './mail-store.ts';

export type MailPart = {
  messageId: string;
  partId: string;
  parentPartId: string | null;
  contentType: string | null;
  charset: string | null;
  transferEncoding: string | null;
  disposition: string | null;
  filename: string | null;
  contentId: string | null;
  isMultipart: boolean;
  isAttachment: boolean;
  declaredBytes: number | null;
  decodedBytes: number | null;
  availableLocally: boolean;
  sha256: string | null;
};

export type MailHeader = {
  messageId: string;
  partId: string;
  position: number;
  name: string;
  value: string;
  rawLineBase64: string;
};
export type DecodedMailPart = {
  record: MailPart;
  path: string | null;
  text: string | null;
};

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
export async function readMailMime(
  store: MailStore,
  messageId: string,
  file: MailFile,
  readHeaders: boolean,
  stageFiles: boolean,
  decode: (part: MailPart) => boolean,
): Promise<{ headers: MailHeader[]; parts: DecodedMailPart[] }> {
  await assertMailFile(file);
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

  const headers: MailHeader[] = [];
  const parts: DecodedMailPart[] = [];
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
    part: DecodedMailPart;
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
    const record = part.record;
    if (
      record.decodedBytes === 0 &&
      record.declaredBytes !== null &&
      record.declaredBytes > 0
    ) {
      const diskId = record.partId;
      const candidates = store.attachments.get(`${messageId}:${diskId}`);
      if (candidates === undefined) {
        record.availableLocally = false;
        record.decodedBytes = null;
        if (part.path !== null) await rm(part.path);
        part.path = null;
        part.text = null;
        return;
      }
      const matches =
        candidates.length === 1
          ? candidates
          : candidates.filter(
              (candidate) => basename(candidate.path) === record.filename,
            );
      if (matches.length !== 1)
        throw new MailSchemaError(
          `Ambiguous detached Mail attachment ${messageId}:${diskId}`,
        );
      const original = matches[0] as MailFile;
      await assertMailFile(original);
      if (part.path !== null) await copyFile(original.path, part.path);
      if (textDecoder !== null)
        part.text = await mailPartText(original.path, textDecoder);
      await assertMailFile(original);
      record.decodedBytes = original.size;
      record.sha256 = await hashMailFile(original);
    } else {
      record.sha256 = hash.digest('hex');
    }
  };

  try {
    for await (const chunk of splitter as AsyncIterable<SplitterChunk>) {
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
              messageId,
              partId: id,
              position,
              name: header.key,
              value: libmime.decodeWords(decoded.value),
              rawLineBase64: Buffer.from(header.line, 'latin1').toString(
                'base64',
              ),
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
        const record: MailPart = {
          messageId,
          partId: id,
          parentPartId:
            node.parentNode === false ? null : partId(node.parentNode),
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
        };
        const part: DecodedMailPart = { record, path: null, text: null };
        parts.push(part);
        if (node.multipart !== false || !decode(record)) continue;
        const extension =
          node.filename === false
            ? node.contentType === 'text/html'
              ? '.html'
              : node.contentType !== false &&
                  node.contentType.startsWith('text/')
                ? '.txt'
                : ''
            : extname(node.filename);
        if (stageFiles)
          part.path = join(
            store.scratch.path,
            `${messageId}-${id}${extension}`,
          );
        const decoder = node.getDecoder();
        const hash = createHash('sha256');
        // Missing charset is MimeNode's documented false value; TextDecoder
        // owns the default. Keep text only when the caller requested bodies.
        const textDecoder =
          !stageFiles &&
          record.contentType !== null &&
          record.contentType.startsWith('text/')
            ? new TextDecoder(
                record.charset === null ? undefined : record.charset,
              )
            : null;
        if (textDecoder !== null) part.text = '';
        record.decodedBytes = 0;
        decoder.on('data', (bytes: Buffer) => {
          hash.update(bytes);
          record.decodedBytes = (record.decodedBytes as number) + bytes.length;
          if (textDecoder !== null)
            part.text += textDecoder.decode(bytes, { stream: true });
        });
        const finished =
          part.path === null
            ? streamFinished(decoder, { cleanup: true })
            : pipeline(decoder, createWriteStream(part.path, { flags: 'wx' }));
        finished.catch((error: unknown) => splitter.destroy(error as Error));
        active = { decoder, finished, part, hash, textDecoder };
      } else if (chunk.type === 'body' && active !== null) {
        if (!active.decoder.write(chunk.value))
          await once(active.decoder, 'drain');
      }
    }
    await finish();
    await input;
    await assertMailFile(file);
    return { headers, parts };
  } catch (error) {
    splitter.destroy(error as Error);
    if (active !== null) active.decoder.destroy(error as Error);
    await input.catch(() => {});
    if (active !== null) await active.finished.catch(() => {});
    await Promise.allSettled(
      parts.flatMap((part) => (part.path === null ? [] : [rm(part.path)])),
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
