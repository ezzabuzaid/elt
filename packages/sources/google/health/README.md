# @workspace/source-google-health

An ELT source for all the data that a Google account keeps in Google Health. It reads the Google Health API v4 (`health.googleapis.com`), which replaces the Fitbit Web API. The data comes from Fitbit and Pixel devices, the Google Health app, and the apps that write to Google Health. The source has 56 streams: each data type, their child lists (for example sleep stages and exercise splits), the TCX routes of exercises, the rollups and the account.

Apple Health data gets to Google Health through the Google Health iPhone app. The points that this app relays have `platform` `HEALTH_KIT`, `deviceManufacturer` `Apple Inc.` and `applicationPackageName` `com.apple.health.<id>`. A Mac has no Health store of its own: macOS 27 has HealthKit, but `isHealthDataAvailable()` is false. Thus this relay is the route for the steps, distance, energy, heart rate and workouts of an Apple Watch.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md), and the glossary of [elt](../../../elt/CONTEXT.md) for the words of all of elt.

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

Copy each stream with `syncMode: 'full_refresh'` and `destinationSyncMode: 'overwrite'`. See [Sync](#sync). The Google app (`apps/google/src/main.ts`) loads each stream into `google_health.raw_<stream>`, and readers query the reader view `marts.health_<snake_stream>`.

| Option              | Default    | What it does                                               |
| ------------------- | ---------- | ---------------------------------------------------------- |
| `requester`         | none       | The authenticated requester from `googleSession`.          |
| `streamConcurrency` | 4          | The number of streams that one read reads at once.         |
| `pollIntervalMs`    | 15 minutes | The time between two probes of a watch. See [Sync](#sync). |

## Authorization

`GOOGLE_HEALTH_SCOPES` holds each Google Health scope that reads data: `activity_and_fitness`, `ecg`, `health_metrics_and_measurements`, `irn`, `location` (the GPS route of an exercise), `nutrition`, `profile`, `settings` and `sleep`, each `.readonly`. The Google Cloud project of the OAuth client must have `health.googleapis.com` enabled. Google calls most of these scopes restricted. An app in production that Google did not verify can sign in 100 users.

Google Health refuses a token that also has the restricted scope of a different API. Thus the session must ask for these scopes only. `googleSession` gives each session a token with only its own scopes. See the access section of [Google Search Console](../search-console/README.md#access) for the OAuth client setup and how `googleSession` operates.

Google refuses an account with no Google Health profile with `400 ACCOUNT_NOT_LINKED`. The source reports it as a `config` failure that tells the user to sign in to the Google Health app. A `401`, a `403` and a grant that Google revoked (`invalid_grant`) are `config` failures too. Each other failure is `system`.

## Streams

| Family          | Streams                                                                                                                                                                                                                                                                                                                      | Key                                                                                                                                                                                                                   | Read                                                                                                                                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Data types      | One for each type: `steps`, `heartRate`, `sleep`, `exercise`, `weight` and 30 more                                                                                                                                                                                                                                           | `name` for the types that a user can edit (exercise, sleep, weight, height, body fat, blood glucose, core body temperature, hydration and nutrition logs, respiratory rate during sleep); none for the measured types | Each point, the newest first, to the last page. Google answers a daily type for each date, also when nothing was recorded. Thus the source reads a daily type from the `membershipStartDate` of the profile. |
| Child lists     | `sleepStages`, `sleepShortAwakenings`, `sleepOutOfBedSegments`, `sleepStageSummaries`, `exerciseEvents`, `exerciseSplits`, `exerciseSplitSummaries`, `nutritionLogNutrients`, `activeMinutesByActivityLevel`, `dailyHeartRateZoneRanges`, `irregularRhythmNotificationAlertWindows`, `irregularRhythmNotificationHeartBeats` | The `name` of the parent and `position`. An entry of a measured parent has the origin and time of the parent in its place                                                                                             | From the same read of the parent in that run.                                                                                                                                                                |
| Exercise routes | `exerciseRoutes`                                                                                                                                                                                                                                                                                                             | `exercise`                                                                                                                                                                                                            | One TCX document for each exercise (`exportExerciseTcx`): the laps, the heart rate samples and, with GPS, the route.                                                                                         |
| Rollups         | `floors`, `totalCalories`, `caloriesInHeartRateZone`                                                                                                                                                                                                                                                                         | `date` (and `heartRateZone`)                                                                                                                                                                                          | Google gives these only as daily totals. Each day from `membershipStartDate` to today, in windows of a maximum of 90 days (floors) or 14 days (the other two) for each request.                              |
| Account         | `identity`, `profile`, `settings`, `irnProfile`, `pairedDevices`                                                                                                                                                                                                                                                             | `healthUserId`, none, none, none, `name`                                                                                                                                                                              | The current answer of the account.                                                                                                                                                                           |

### Values

- Each point has its origin: `platform`, `recordingMethod`, `deviceDisplayName`, `deviceFormFactor`, `deviceManufacturer` and the application that wrote it.
- The points of a measured type overlap across devices. On 2026-10-13, Apple Health relayed 14,062 iPhone steps and 13,926 Apple Watch steps for the same walk, beside 990 Fitbit Air steps. A total over all points counts the same activity more than one time. Thus total the points of one device. The description of each measured stream tells this.
- The instants of a measured point load as `date-time` to the microsecond (`TIMESTAMPTZ` in Postgres).
- A session that an app wrote (an exercise, a sleep, a hydration or nutrition log, an ECG, an irregular rhythm notification) and its child lists keep nine fraction digits. Postgres keeps them as text, sorted with `COLLATE "C"`. For example, one exercise on 2026-10-15 started at `15:55:06.688527107Z`.
- When a value has more digits than its column keeps, the read fails. The value is not cut.
- Each span or sample also loads its UTC offset in seconds and the civil (local) time of Google.
- 64-bit counts load as `int64`.
- Google sends the string `NaN` for a double that it could not compute, for example a sleep temperature baseline before there are sufficient nights. It loads as `null`.

## Sync

Google keeps no change record that a source can read. `list` filters only on when a point occurred. Most points have no id and no update time. Only a public webhook gets deletions. Thus the source reads each stream completely on each run, and the copy loads it with Full Refresh | Overwrite. SQL Server uses the same strategy for tables with no cursor. See [ADR 0001](./docs/adr/0001-each-stream-is-read-completely-on-each-run.md).

Each stream loads into a hidden table. The hidden table replaces the old table when the stream ends with no failure. Thus a failed read keeps the previous rows. An edit or a deletion upstream shows after the next run.

The source reads four streams at once through one SDK object. The SDK keeps the requests below 300 each minute for each user, the limit of Google. The daily rollups send about 150 small requests quickly. Without this pacing, they got `429` on 2026-10-15.

`observe()` polls each 15 minutes. It reads the last sync times of the paired devices and the newest point of steps, heart rate, exercise, sleep and weight. When one of them moved, all streams wake. An edit to an old point alone moves none of them. When a probe call fails, the failure is part of the fingerprint. When the call starts or stops failing, the streams wake, and the extraction reports the failure or loads the data. The Search Console source has the same probe code. See the [ledger](./docs/copied-from-search-console.md).

## Not read

- Moods, symptoms, menstrual periods and ovulation tests. The API accepts only writes for them (`UNSUPPORTED_DATA_TYPE_ACTION`, allowed `create, update, batchDelete`). Thus the read scopes `mindfulness`, `logged_symptoms` and `reproductive_health` have nothing to read.
- Foods and food measurement units. This is the public food catalog of Google (`FOOD_ACCESS_LEVEL_PUBLIC` brand items, more than 1,250 units), not data of the user. The list cannot be filtered by access level, and deep pages answer `503`. A nutrition log keeps the food details that it has.
- The personal ranges of resting heart rate and heart rate variability. The discovery document lists them in the values of daily rollups, but no data type gave them on 2026-10-15.
- The activity rings of Apple and their goals. No Google Health type has them. Backlog #2633 reads them from an encrypted iPhone backup.
- The streams that Google reconciles across devices. Backlog #2642 is the request to add them.

## Limitations

- A measured type has points from more than one device that overlap. Total the points of one device, not all points.
- An edit or a deletion upstream shows after the next run.
- `observe()` wakes on new data, but not on an edit to an old point alone.
- A value that Google could not compute (`NaN`) loads as `null`.
- Each run reads each stream completely.

## Live checks

On 2026-10-15, one account had a Fitbit Air since 2026-07-01, older Fitbit history from 2021-04-06, and an Apple Watch that the Google Health iPhone app relayed. `nx run google:test` ran the app one time. Search Console and all 56 Google Health streams loaded in 200 seconds, and the agent role read each `marts.health_*` view. The data included:

- 1,005,119 heart rate points.
- 15,247 steps, 6,509 of them `HEALTH_KIT`.
- 44 exercises with 44 TCX documents.
- 17 sleeps with 493 stages.
- 4,038 daily heart rate zones from the membership date.
- 2,019 days of total calories.

Two earlier passes failed, and the failures were repaired. `dailySleepTemperatureDerivations` failed on the `NaN` strings of Google. One exercise had a start time in nanoseconds, and a burst of rollup requests went above the quota for each minute.

Other checks on the same day:

- A refresh token from Testing mode expired after 14 days (`invalid_grant`).
- Deep pages answered `503`, and a retry read the same page.
- Pages had about 5,000 points, although the request asked for 10,000.
- Google gave the points newest first across pages.
- `daily-heart-rate-zones` answered dates with no end until the request had a limit.

## Decisions

- [ADR 0001](./docs/adr/0001-each-stream-is-read-completely-on-each-run.md): each stream is read completely on each run.

## Development

Run the commands from the workspace root.

```sh
npx nx run source-google-health:test        # builds, then runs src/*.test.ts with msw and Docker
npx nx run source-google-health:typecheck   # formats, lints, then type checks
```
