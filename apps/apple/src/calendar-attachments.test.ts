import assert from 'node:assert/strict';
import { mkdtempDisposable, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { GoogleRequester } from 'google-auth';

import { googleCalendarAttachments } from './index.ts';

type Call = { url: string; headers?: Readonly<Record<string, string>> };

// Plays Google's APIs at the requester seam and records each request.
function recorder(reply: (call: Call) => unknown) {
  const calls: Call[] = [];
  const requester: GoogleRequester = {
    async request({ url, headers }) {
      const call: Call = { url, ...(headers ? { headers } : {}) };
      calls.push(call);
      return { data: reply(call) };
    },
  };
  return { calls, requester };
}

// Shaped like the GaxiosError google-auth-library throws.
function googleError(status: number, data: unknown = {}) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    status,
    response: { status, data },
  });
}

const attachment = (uri: string) => ({
  uri,
  filename: null,
  formatType: null,
  calendarId: 'calendar',
  calendarItemId: 'item',
});

test('Calendar attachments download Drive files and Gmail parts, and report unreachable ones', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;
  const pdf = new TextEncoder().encode('%PDF-1.7').buffer;
  const { calls, requester } = recorder(({ url }) => {
    if (url.includes('/files/image?fields')) return { mimeType: 'image/png' };
    if (url.includes('/files/image?alt=media')) return png;
    if (url.includes('/files/doc?fields'))
      return { mimeType: 'application/vnd.google-apps.document' };
    if (url.includes('/files/doc/export?mimeType=application%2Fpdf'))
      return pdf;
    if (url.includes('/files/private'))
      throw googleError(403, { error: { errors: [{ reason: 'forbidden' }] } });
    if (url.includes('/files/gone')) throw googleError(404);
    if (url.includes('/messages/m1?format=full'))
      return {
        id: 'm1',
        payload: {
          partId: '',
          parts: [
            { partId: '0', body: { size: 3 } },
            { partId: '1', filename: 'a.pdf', body: { attachmentId: 'att-1' } },
          ],
        },
      };
    if (url.includes('/messages/m1/attachments/att-1'))
      return { data: Buffer.from('mail bytes').toString('base64url') };
    if (url.includes('/messages/t1?format=full')) throw googleError(404);
    if (url.includes('/threads/t1?format=full'))
      return {
        messages: [
          {
            id: 'm2',
            payload: {
              parts: [
                {
                  partId: '2',
                  body: { data: Buffer.from('inline').toString('base64url') },
                },
              ],
            },
          },
        ],
      };
    throw new Error(`unexpected ${url}`);
  });
  const fetch = googleCalendarAttachments(requester);
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'gcal-att-'));
  const saved = async (uri: string) => {
    const path = join(scratch.path, `f${calls.length}`);
    const result = await fetch(attachment(uri), path);
    return result ? new Uint8Array(await readFile(path)) : result;
  };

  assert.deepEqual(
    await saved('https://drive.google.com/file/d/image/view?usp=drive_web'),
    new Uint8Array(png),
  );
  assert.deepEqual(
    await saved('https://drive.google.com/open?id=doc&authuser=0'),
    new Uint8Array(pdf),
  );
  assert.deepEqual(
    await saved('?view=att&th=m1&attid=0.1&disp=safe&zw'),
    new Uint8Array(Buffer.from('mail bytes')),
  );
  assert.deepEqual(
    await saved('?view=att&th=t1&attid=0.2&disp=safe&zw'),
    new Uint8Array(Buffer.from('inline')),
  );
  assert.equal(
    await saved('https://drive.google.com/file/d/private/view'),
    false,
  );
  assert.equal(await saved('https://drive.google.com/file/d/gone/view'), false);
  assert.equal(await saved('https://example.com/file.pdf'), false);
  assert.equal(await saved('?view=att&th=m1&attid=0.9'), false);
});

test('Calendar attachment downloads fail on a disabled API, a missing scope or a server error', async () => {
  for (const [error, message] of [
    [
      googleError(403, {
        error: { errors: [{ reason: 'accessNotConfigured' }] },
      }),
      /403/,
    ],
    [
      googleError(403, {
        error: {
          status: 'PERMISSION_DENIED',
          details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }],
        },
      }),
      /403/,
    ],
    [googleError(500), /500/],
  ] as const) {
    const { requester } = recorder(() => {
      throw error;
    });
    await assert.rejects(
      googleCalendarAttachments(requester)(
        attachment('https://drive.google.com/file/d/abc/view'),
        '/unused',
      ),
      message,
    );
  }
});

test('a rate-limited Drive download rejects instead of loading no file', async () => {
  for (const reason of ['userRateLimitExceeded', 'rateLimitExceeded']) {
    const { requester } = recorder(() => {
      throw googleError(403, { error: { errors: [{ reason }] } });
    });
    await assert.rejects(
      googleCalendarAttachments(requester)(
        attachment('https://drive.google.com/file/d/abc/view'),
        '/unused',
      ),
      /403/,
    );
  }
});

test('a Drive shortcut downloads its target, and a link-shared file sends its resource key', async () => {
  const bytes = new TextEncoder().encode('target bytes').buffer;
  const { calls, requester } = recorder(({ url }) => {
    if (url.includes('/files/shortcut?fields'))
      return {
        mimeType: 'application/vnd.google-apps.shortcut',
        shortcutDetails: { targetId: 'target', targetResourceKey: 'key-2' },
      };
    if (url.includes('/files/target?fields')) return { mimeType: 'image/png' };
    if (url.includes('/files/target?alt=media')) return bytes;
    if (url.includes('/files/shared?fields')) return { mimeType: 'image/png' };
    if (url.includes('/files/shared?alt=media')) return bytes;
    throw new Error(`unexpected ${url}`);
  });
  const fetch = googleCalendarAttachments(requester);
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'gcal-sc-'));

  assert.equal(
    await fetch(
      attachment('https://drive.google.com/file/d/shortcut/view'),
      join(scratch.path, 'a'),
    ),
    true,
  );
  assert.equal(
    await fetch(
      attachment(
        'https://drive.google.com/file/d/shared/view?resourcekey=key-1',
      ),
      join(scratch.path, 'b'),
    ),
    true,
  );

  assert.equal(await readFile(join(scratch.path, 'a'), 'utf8'), 'target bytes');
  assert.deepEqual(
    calls
      .filter(({ url }) => !url.includes('/files/shortcut'))
      .map(({ headers }) => headers?.['X-Goog-Drive-Resource-Keys']),
    ['target/key-2', 'target/key-2', 'shared/key-1', 'shared/key-1'],
  );
});
