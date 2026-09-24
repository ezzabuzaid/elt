import assert from 'node:assert/strict';
import { test } from 'node:test';

import { OAuth2Client } from 'google-auth-library';

import type { GoogleRequester } from './requester.ts';

test('OAuth2Client satisfies GoogleRequester without an assertion', () => {
  // The seam only holds while the real class structurally matches. A widened
  // or renamed request signature fails this file at typecheck, not in a
  // product module that already assumed the client fits.
  const client: GoogleRequester = new OAuth2Client({
    clientId: 'client-id',
    clientSecret: 'client-secret',
  });
  assert.equal(typeof client.request, 'function');
});

test('a stub satisfies GoogleRequester without knowing the library', async () => {
  const calls: { url: string; method?: string }[] = [];
  const stub: GoogleRequester = {
    async request(options) {
      calls.push({ method: options.method, url: options.url });
      return { data: { siteEntry: [] } };
    },
  };

  const response = await stub.request({
    method: 'GET',
    url: 'https://searchconsole.googleapis.com/webmasters/v3/sites',
  });

  // The response body stays unknown, so each caller narrows it once itself.
  assert.deepEqual(response.data, { siteEntry: [] });
  assert.deepEqual(calls, [
    {
      method: 'GET',
      url: 'https://searchconsole.googleapis.com/webmasters/v3/sites',
    },
  ]);
});
