import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { GoogleRequester } from './requester.ts';

/**
 * Writes the body of a GET to `path` as it arrives, so a large file is never
 * held in memory. A refusal rejects with the error of the requester before
 * any file is made; `statusOf`, `reasonsOf` and `messageOf` read it.
 */
export async function download(
  requester: GoogleRequester,
  request: {
    readonly url: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal;
  },
  path: string,
): Promise<void> {
  const { data } = await requester.request({
    ...request,
    responseType: 'stream',
  });
  if (!(data instanceof Readable))
    throw new TypeError(`Google returned no content for ${request.url}`);
  await pipeline(data, createWriteStream(path), { signal: request.signal });
}
