# @workspace/source-google-health

An ELT source for everything a Google account keeps in Google Health: 56 streams covering each data type, their child lists (sleep stages, exercise splits), exercise TCX routes, the daily-only rollups and the account. Apple Health data the Google Health iPhone app relays arrives in the same streams with `platform` `HEALTH_KIT`.

```ts
import { GOOGLE_HEALTH_SCOPES, googleSession } from '@workspace/google-auth';
import { GoogleHealthSource } from '@workspace/source-google-health/google-health-source';

const source = new GoogleHealthSource({
  requester: await googleSession({
    clientId,
    clientSecret,
    scopes: GOOGLE_HEALTH_SCOPES,
    directory,
  }),
});
```

Copy every stream with `syncMode: 'full_refresh'` and `destinationSyncMode: 'overwrite'`: Google keeps no change record a source can read, so each run reads every stream whole.

Limitations: a measured type holds overlapping points from several devices (Apple Health relays an iPhone's and an Apple Watch's steps for the same walk, beside a Fitbit's), so total one device's points rather than all of them (backlog #2642 would add Google's deduplicated streams); an edit or deletion upstream shows after the next run; `observe()` wakes on new data but not on an edit to an old point alone; a value Google could not compute (`NaN`) loads as `null`; Apple's activity rings are not in Google Health. See [docs/reference.md](../../../../docs/reference.md#google-health).
