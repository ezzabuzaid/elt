# @workspace/sdk-google-health

The Google Health API v4 (`health.googleapis.com`) for the signed-in user: each data type's points, the types Google answers only as daily rollups, an exercise's TCX export, and the account's identity, profile, settings, IRN profile and paired devices. Responses are parsed with zod schemas typed from Google's discovery document (revision 20261014) and checked against live responses.

```ts
import { GOOGLE_HEALTH_SCOPES, googleSession } from '@workspace/google-auth';
import { GoogleHealthApi } from '@workspace/sdk-google-health';

const api = new GoogleHealthApi(
  await googleSession({
    clientId,
    clientSecret,
    scopes: GOOGLE_HEALTH_SCOPES,
    directory,
  }),
);
for await (const point of api.dataPoints('heart-rate'))
  console.log(point.heartRate?.beatsPerMinute);
```

- `dataPoints(type)` follows `nextPageToken` to the end; a daily type takes `since`, because Google answers every date.
- `dailyRollUp(type, { start, end })` asks in windows of the type's maximum span (90 days for floors, 14 for the calorie types).
- A `503`, `5xx` or `429` is retried with backoff, honoring `Retry-After`; a rate limit that outlasts the retries is a `GoogleHealthRateLimitError`. `ACCOUNT_NOT_LINKED` is a `GoogleHealthAccountNotLinkedError`.
- A double Google sends as `NaN`, `Infinity` or `-Infinity` reads as that number.

Limitations: moods, symptoms, menstrual periods and ovulation tests accept only writes, so they are not offered; the public food catalog is not offered. The retry loop is a copy of the Search Console SDK's ([ledger](docs/copied-from-search-console.md)).
