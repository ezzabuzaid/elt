import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type HttpHandler, HttpServer } from '@zukhruf/testing/http';
import { OAuth2Client } from 'google-auth-library';

import { attemptsOf, googleRetry, reasonsOf, statusOf } from './index.ts';

type Answer = {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
};

const OK: Answer = { body: { ok: true }, status: 200 };
const NOW = Date.parse('2026-11-13T10:00:00Z');

function refusal(status: number, reason: string, retryAfter?: string): Answer {
  return {
    body: { error: { code: status, errors: [{ reason }], message: reason } },
    status,
    ...(retryAfter === undefined
      ? {}
      : { headers: { 'retry-after': retryAfter } }),
  };
}

// Answers the requests in order and notes each one. A request past the end of
// the script throws, which fails the run.
function scripted(requests: string[], answers: readonly Answer[]): HttpHandler {
  return (request, response) => {
    const answer = answers[requests.length];
    requests.push(`${request.method} ${request.url}`);
    assert.ok(answer, 'a request the script does not answer');
    response.writeHead(answer.status, {
      'content-type': 'application/json',
      ...answer.headers,
    });
    response.end(JSON.stringify(answer.body));
  };
}

function client(): OAuth2Client {
  const oauth = new OAuth2Client({
    clientId: 'client-id',
    clientSecret: 'client-secret',
  });
  oauth.setCredentials({
    access_token: 'fake-access-token',
    expiry_date: Date.now() + 3_600_000,
  });
  return oauth;
}

// Notes each wait asked of it and ends the wait at once, so a test reads the
// waits of the policy without living through them.
function instantClock(waits: number[]) {
  return {
    Date: { now: () => NOW },
    clearTimeout,
    performance,
    setTimeout(callback: () => void, ms: number) {
      waits.push(ms);
      return setTimeout(callback, 0);
    },
  };
}

test('a 429 on a POST is sent again once, after a wait on the clock of the caller', async () => {
  const requests: string[] = [];
  const waits: number[] = [];
  await using google = await new HttpServer().start(
    scripted(requests, [refusal(429, 'rateLimitExceeded'), OK]),
  );

  const response = await client().request({
    data: { startDate: '2026-11-01' },
    method: 'POST',
    url: `${google.origin}/query`,
    ...googleRetry({ clock: instantClock(waits) }),
  });

  assert.deepEqual(response.data, { ok: true });
  assert.deepEqual(requests, ['POST /query', 'POST /query']);
  assert.equal(waits.length, 1);
  // Full jitter: any wait below the first ceiling of 1 s.
  assert.ok(waits[0] !== undefined && waits[0] >= 0 && waits[0] < 1000);
});

test('Retry-After in seconds is the wait', async () => {
  const requests: string[] = [];
  const waits: number[] = [];
  await using google = await new HttpServer().start(
    scripted(requests, [refusal(429, 'rateLimitExceeded', '7'), OK]),
  );

  await client().request({
    url: `${google.origin}/sites`,
    ...googleRetry({ clock: instantClock(waits) }),
  });

  assert.deepEqual(requests, ['GET /sites', 'GET /sites']);
  assert.deepEqual(waits, [7000]);
});

test('Retry-After as an HTTP date waits until that date on the clock of the caller', async () => {
  const requests: string[] = [];
  const waits: number[] = [];
  await using google = await new HttpServer().start(
    scripted(requests, [
      {
        headers: { 'retry-after': new Date(NOW + 9000).toUTCString() },
        status: 503,
      },
      OK,
    ]),
  );

  await client().request({
    url: `${google.origin}/sites`,
    ...googleRetry({ clock: instantClock(waits) }),
  });

  assert.deepEqual(waits, [9000]);
});

test('a Retry-After longer than 60 s fails at once', async () => {
  const requests: string[] = [];
  const waits: number[] = [];
  await using google = await new HttpServer().start(
    scripted(requests, [refusal(429, 'rateLimitExceeded', '3600'), OK]),
  );

  await assert.rejects(
    client().request({
      url: `${google.origin}/sites`,
      ...googleRetry({ clock: instantClock(waits) }),
    }),
    (error: unknown) => {
      assert.equal(statusOf(error), 429);
      assert.equal(attemptsOf(error), 1);
      return true;
    },
  );

  assert.deepEqual(requests, ['GET /sites']);
  assert.deepEqual(waits, []);
});

test('a 403 that is not a rate limit is not sent again', async () => {
  const requests: string[] = [];
  const waits: number[] = [];
  await using google = await new HttpServer().start(
    scripted(requests, [refusal(403, 'cannotDownloadFile'), OK]),
  );

  await assert.rejects(
    client().request({
      url: `${google.origin}/file`,
      ...googleRetry({ clock: instantClock(waits) }),
    }),
    (error: unknown) => {
      assert.deepEqual(reasonsOf(error), ['cannotDownloadFile']);
      return true;
    },
  );

  assert.deepEqual(requests, ['GET /file']);
});

test('a 403 rate limit and each transient status are sent again', async () => {
  const requests: string[] = [];
  const waits: number[] = [];
  await using google = await new HttpServer().start(
    scripted(requests, [
      refusal(403, 'userRateLimitExceeded'),
      { status: 408 },
      { status: 500 },
      { status: 504 },
      OK,
    ]),
  );

  const response = await client().request({
    url: `${google.origin}/sites`,
    ...googleRetry({ clock: instantClock(waits) }),
  });

  assert.deepEqual(response.data, { ok: true });
  assert.equal(requests.length, 5);
});

test('the fifth refusal is the error, and it counts five attempts', async () => {
  const requests: string[] = [];
  const waits: number[] = [];
  await using google = await new HttpServer().start(
    scripted(
      requests,
      Array.from({ length: 6 }, () => refusal(429, 'rateLimitExceeded')),
    ),
  );

  await assert.rejects(
    client().request({
      url: `${google.origin}/sites`,
      ...googleRetry({ clock: instantClock(waits) }),
    }),
    (error: unknown) => {
      assert.equal(statusOf(error), 429);
      assert.equal(attemptsOf(error), 5);
      return true;
    },
  );

  assert.equal(requests.length, 5);
  // The ceiling doubles from 1 s with each attempt.
  assert.equal(waits.length, 4);
  for (const [index, wait] of waits.entries())
    assert.ok(wait >= 0 && wait < 1000 * 2 ** index, `wait ${index}: ${wait}`);
});

test('an abort during a wait rejects with the reason of the signal', async () => {
  const requests: string[] = [];
  const stopped = new Error('the caller stopped');
  const controller = new AbortController();
  await using google = await new HttpServer().start(
    scripted(requests, [refusal(429, 'rateLimitExceeded'), OK]),
  );
  // The wait never ends by itself: the caller stops from a later macrotask.
  const clock = {
    Date,
    clearTimeout,
    performance,
    setTimeout(callback: () => void) {
      setImmediate(() => controller.abort(stopped));
      return setTimeout(callback, 60_000);
    },
  };

  await assert.rejects(
    client().request({
      signal: controller.signal,
      url: `${google.origin}/sites`,
      ...googleRetry({ clock, signal: controller.signal }),
    }),
    (error: unknown) => error === stopped,
  );

  assert.deepEqual(requests, ['GET /sites']);
});

test('the rate-limit reasons of the caller take the place of the usual two', async () => {
  const requests: string[] = [];
  const waits: number[] = [];
  await using google = await new HttpServer().start(
    scripted(requests, [
      refusal(403, 'RESOURCE_EXHAUSTED'),
      refusal(403, 'rateLimitExceeded'),
      OK,
    ]),
  );

  await assert.rejects(
    client().request({
      url: `${google.origin}/dataPoints`,
      ...googleRetry({
        clock: instantClock(waits),
        rateLimitReasons: ['RESOURCE_EXHAUSTED'],
      }),
    }),
    (error: unknown) => {
      assert.deepEqual(reasonsOf(error), ['rateLimitExceeded']);
      assert.equal(attemptsOf(error), 2);
      return true;
    },
  );

  assert.equal(requests.length, 2);
});

test('a request that got no response is not sent again', async () => {
  const requests: string[] = [];
  const waits: number[] = [];
  await using google = await new HttpServer().start((request) => {
    requests.push(`${request.method} ${request.url}`);
    request.socket.destroy();
  });

  await assert.rejects(
    client().request({
      url: `${google.origin}/sites`,
      ...googleRetry({ clock: instantClock(waits) }),
    }),
    (error: unknown) => {
      assert.equal(statusOf(error), undefined);
      assert.equal(attemptsOf(error), 1);
      return true;
    },
  );

  assert.deepEqual(requests, ['GET /sites']);
});
