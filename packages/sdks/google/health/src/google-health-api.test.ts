import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';

import { GoogleGrant, GoogleOAuthApp } from '@workspace/google-auth';

import {
  GoogleHealthAccountNotLinkedError,
  GoogleHealthApi,
  GoogleHealthRateLimitError,
} from './index.ts';

const HEALTH = 'https://health.googleapis.com/v4/users/me';

// A real OAuth client over a stored grant: its first call mints an access
// token at the token endpoint the test's server answers.
function signedIn() {
  return new GoogleOAuthApp({
    clientId: 'client-id',
    clientSecret: 'client-secret',
  }).client(
    new GoogleGrant({
      kind: 'GOOGLE_BIGQUERY_OAUTH',
      clientId: 'client-id',
      refreshToken: 'refresh-token',
      scope: 'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
    }),
    ['https://www.googleapis.com/auth/googlehealth.sleep.readonly'],
  );
}

/**
 * Google's side of the wire for one test: the token endpoint, and every
 * Health call answered by `reply` with a JSON body or a whole Response. The
 * requests Health received are kept with their query and body. Any other
 * request fails the test.
 */
function google(reply: (request: Request, url: URL) => unknown) {
  const received: { url: URL; body: unknown }[] = [];
  const server = setupServer(
    http.post('https://oauth2.googleapis.com/token', () =>
      HttpResponse.json({ access_token: 'access-token', expires_in: 3600 }),
    ),
    http.all('https://health.googleapis.com/*', async ({ request }) => {
      const url = new URL(request.url);
      received.push({
        url,
        body: request.method === 'POST' ? await request.clone().json() : null,
      });
      const answer = await reply(request, url);
      return answer instanceof Response ? answer : Response.json(answer);
    }),
  );
  server.listen({ onUnhandledFrame: 'error' });
  return {
    api: new GoogleHealthApi(signedIn()),
    received,
    [Symbol.dispose]: () => server.close(),
  };
}

// An error as the Health API answers one: the reason sits in an ErrorInfo
// detail (AIP-193), as captured live on 2026-10-15.
function refusal(
  status: number,
  reason: string,
  message: string,
  headers?: HeadersInit,
) {
  return HttpResponse.json(
    {
      error: {
        code: status,
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            domain: 'health.googleapis.com',
            reason,
          },
        ],
        message,
        status: status === 429 ? 'RESOURCE_EXHAUSTED' : 'UNAVAILABLE',
      },
    },
    { headers: { 'retry-after': '0', ...headers }, status },
  );
}

// One steps point as the API returns it, at the given start time.
function steps(startTime: string, count: string) {
  return {
    dataSource: { platform: 'FITBIT', recordingMethod: 'PASSIVELY_MEASURED' },
    steps: {
      count,
      interval: {
        endTime: startTime,
        endUtcOffset: '10800s',
        startTime,
        startUtcOffset: '10800s',
      },
    },
  };
}

async function collect<T>(points: AsyncIterable<T>): Promise<T[]> {
  const all: T[] = [];
  for await (const point of points) all.push(point);
  return all;
}

test('paging follows nextPageToken to its end, even past a page shorter than the page size', async () => {
  using health = google((_request, url) => {
    switch (url.searchParams.get('pageToken')) {
      case null:
        return {
          dataPoints: [steps('2026-10-14T10:00:00Z', '12')],
          nextPageToken: 'page-2',
        };
      case 'page-2':
        return {
          dataPoints: [steps('2026-10-13T10:00:00Z', '7')],
          nextPageToken: 'page-3',
        };
      default:
        return { dataPoints: [steps('2026-10-12T10:00:00Z', '3')] };
    }
  });

  const points = await collect(health.api.dataPoints('steps'));

  assert.deepEqual(
    points.map((point) => point.steps?.count),
    ['12', '7', '3'],
  );
});

test('a data type with no data reads as no points', async () => {
  using health = google(() => ({}));

  assert.deepEqual(await collect(health.api.dataPoints('blood-glucose')), []);
});

test('a 503 on a later page is retried and the read continues from that page', async () => {
  let failures = 1;
  using health = google((_request, url) => {
    if (url.searchParams.get('pageToken') !== 'page-2')
      return {
        dataPoints: [steps('2026-10-14T10:00:00Z', '12')],
        nextPageToken: 'page-2',
      };
    if (failures-- > 0)
      return refusal(
        503,
        'UNAVAILABLE',
        'The service is currently unavailable.',
      );
    return { dataPoints: [steps('2026-10-13T10:00:00Z', '7')] };
  });

  const points = await collect(health.api.dataPoints('steps'));

  assert.deepEqual(
    points.map((point) => point.steps?.count),
    ['12', '7'],
  );
  assert.deepEqual(
    health.received.map(({ url }) => url.searchParams.get('pageToken')),
    [null, 'page-2', 'page-2'],
  );
});

test('a 429 waits for Retry-After and then reads on', async () => {
  let failures = 1;
  // Two seconds is longer than the first backoff could be, so only the
  // header can explain the wait.
  using health = google(() =>
    failures-- > 0
      ? refusal(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded or rate limited.', {
          'retry-after': '2',
        })
      : { dataPoints: [steps('2026-10-14T10:00:00Z', '12')] },
  );
  const started = Date.now();

  const points = await collect(health.api.dataPoints('steps'));

  assert.equal(points.length, 1);
  assert.ok(Date.now() - started >= 2000, 'waited as long as Google asked');
});

test('a 429 that outlasts every retry fails as a rate limit naming the call, and a 503 that does fails as itself', async () => {
  {
    using limited = google(() =>
      refusal(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded or rate limited.'),
    );
    await assert.rejects(
      collect(limited.api.dataPoints('steps')),
      (error: unknown) => {
        assert.ok(error instanceof GoogleHealthRateLimitError);
        assert.match(error.message, /steps/);
        return true;
      },
    );
  }

  using unavailable = google(() =>
    refusal(503, 'UNAVAILABLE', 'The service is currently unavailable.'),
  );
  await assert.rejects(
    collect(unavailable.api.dataPoints('steps')),
    /The service is currently unavailable/,
  );
});

test('an account with no Google Health profile is refused with a typed error that names the fix', async () => {
  using health = google(() =>
    refusal(
      400,
      'ACCOUNT_NOT_LINKED',
      'The Google account is not linked to a Fitbit account.',
    ),
  );

  await assert.rejects(
    collect(health.api.dataPoints('steps')),
    (error: unknown) => {
      assert.ok(error instanceof GoogleHealthAccountNotLinkedError);
      assert.match(error.message, /Google Health app/);
      return true;
    },
  );
});

// A civil date as the API spells one, and its ISO day.
type CivilDate = { date?: { year?: number; month?: number; day?: number } };
const iso = (civil: CivilDate | undefined) =>
  new Date(
    Date.UTC(
      Number(civil?.date?.year),
      Number(civil?.date?.month) - 1,
      Number(civil?.date?.day),
    ),
  )
    .toISOString()
    .slice(0, 10);

test('a daily rollup over a long range comes back for every day, though each request may cover only the days the type allows', async () => {
  // As live on 2026-10-15: total-calories answers at most 14 days per
  // request, and a request's page must cover its whole range.
  using health = google(async (request) => {
    const body: {
      range: { start: CivilDate; end: CivilDate };
      pageSize?: number;
    } = await request.json();
    const start = Date.parse(iso(body.range.start));
    const days = (Date.parse(iso(body.range.end)) - start) / 86_400_000;
    if (days > 14)
      return HttpResponse.json(
        {
          error: {
            code: 400,
            details: [
              {
                '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                metadata: { dataType: 'total-calories', maxDurationDays: '14' },
                reason: 'INVALID_ROLLUP_QUERY_DURATION',
              },
            ],
            status: 'INVALID_ARGUMENT',
          },
        },
        { status: 400 },
      );
    if ((body.pageSize ?? 0) < days)
      return HttpResponse.json(
        { error: { code: 400, status: 'INVALID_ARGUMENT' } },
        { status: 400 },
      );
    return {
      rollupDataPoints: Array.from({ length: days }, (_, offset) => {
        const day = new Date(start + offset * 86_400_000);
        const civil = {
          date: {
            day: day.getUTCDate(),
            month: day.getUTCMonth() + 1,
            year: day.getUTCFullYear(),
          },
        };
        return {
          civilEndTime: civil,
          civilStartTime: civil,
          totalCalories: { kcalSum: 2000 + offset },
        };
      }),
    };
  });

  const rows = await collect(
    health.api.dailyRollUp('total-calories', {
      end: '2026-10-15',
      start: '2026-09-01',
    }),
  );

  const days = rows.map((row) => iso(row.civilStartTime));
  assert.equal(days.length, 44);
  assert.equal(new Set(days).size, 44);
  assert.equal(days.toSorted()[0], '2026-09-01');
  assert.equal(days.toSorted().at(-1), '2026-10-14');
});
