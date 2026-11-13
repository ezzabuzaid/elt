import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/testing/fs';
import { type HttpHandler, HttpServer } from '@zukhruf/testing/http';
import { OAuth2Client } from 'google-auth-library';

import { download, messageOf, reasonsOf, statusOf } from './index.ts';

const REFUSAL = {
  error: {
    code: 403,
    errors: [{ message: 'no download', reason: 'cannotDownloadFile' }],
    message: 'The user does not have sufficient permissions for this file.',
    status: 'PERMISSION_DENIED',
  },
};

const refuses: HttpHandler = (_request, response) => {
  response.writeHead(403, { 'content-type': 'application/json' });
  response.end(JSON.stringify(REFUSAL));
};

// 3 MiB in 64 KiB writes: more than one chunk reaches the client.
function serves(bytes: Buffer): HttpHandler {
  return (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    for (let at = 0; at < bytes.length; at += 65_536)
      response.write(bytes.subarray(at, at + 65_536));
    response.end();
  };
}

// The client as GoogleOAuthApp builds it, and one on Node's own fetch: gaxios
// gives a failed streamed body in another shape for each.
function clients(): OAuth2Client[] {
  const all = [
    new OAuth2Client({ clientId: 'client-id', clientSecret: 'client-secret' }),
    new OAuth2Client({ clientId: 'client-id', clientSecret: 'client-secret' }),
  ];
  for (const oauth of all)
    oauth.setCredentials({
      access_token: 'fake-access-token',
      expiry_date: Date.now() + 3_600_000,
    });
  const [, native] = all;
  assert.ok(native);
  native.transporter.defaults.fetchImplementation = fetch;
  return all;
}

test('the file on disk holds the bytes that Google served', async () => {
  const bytes = randomBytes(3 * 2 ** 20);
  await using google = await new HttpServer().start(serves(bytes));
  await using scratch = await new TemporaryFiles().directory('download-');

  const [requester] = clients();
  assert.ok(requester);
  const path = join(scratch.path, 'file.bin');

  await download(requester, { url: `${google.origin}/file` }, path);

  assert.ok(bytes.equals(await readFile(path)));
});

test('the request carries the headers of the caller', async () => {
  const seen: (string | string[] | undefined)[] = [];
  await using google = await new HttpServer().start((request, response) => {
    seen.push(request.headers['x-goog-drive-resource-keys']);
    response.end('bytes');
  });
  await using scratch = await new TemporaryFiles().directory('download-');
  const [requester] = clients();
  assert.ok(requester);

  await download(
    requester,
    {
      headers: { 'X-Goog-Drive-Resource-Keys': 'file-id/key' },
      url: `${google.origin}/file`,
    },
    join(scratch.path, 'file.bin'),
  );

  assert.deepEqual(seen, ['file-id/key']);
});

test('a refusal rejects with the status, reasons and message of Google, and writes no file', async () => {
  await using google = await new HttpServer().start(refuses);
  await using scratch = await new TemporaryFiles().directory('download-');

  for (const [index, requester] of clients().entries()) {
    const path = join(scratch.path, `file-${index}.bin`);

    await assert.rejects(
      download(requester, { url: `${google.origin}/file` }, path),
      (error: unknown) => {
        assert.equal(statusOf(error), 403);
        assert.deepEqual(reasonsOf(error), ['cannotDownloadFile']);
        assert.equal(messageOf(error), REFUSAL.error.message);
        return true;
      },
    );

    assert.equal(existsSync(path), false, `client ${index}`);
  }
});

test('a refusal whose body is not the JSON of Google keeps its text as the message', async () => {
  await using google = await new HttpServer().start((_request, response) => {
    response.writeHead(503, { 'content-type': 'text/plain' });
    response.end('upstream connect error');
  });
  await using scratch = await new TemporaryFiles().directory('download-');
  const [requester] = clients();
  assert.ok(requester);

  await assert.rejects(
    download(
      requester,
      { url: `${google.origin}/file` },
      join(scratch.path, 'file.bin'),
    ),
    (error: unknown) => {
      assert.equal(statusOf(error), 503);
      assert.deepEqual(reasonsOf(error), []);
      assert.equal(messageOf(error), 'upstream connect error');
      return true;
    },
  );
});

test('an abort stops a download whose body has not ended', async () => {
  const controller = new AbortController();
  // The body never ends: only the caller stops it, from a later macrotask.
  await using google = await new HttpServer().start((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    response.write(Buffer.alloc(65_536));
    setTimeout(() => controller.abort(), 50);
  });
  await using scratch = await new TemporaryFiles().directory('download-');
  const [requester] = clients();
  assert.ok(requester);

  await assert.rejects(
    download(
      requester,
      { signal: controller.signal, url: `${google.origin}/file` },
      join(scratch.path, 'file.bin'),
    ),
  );
});
