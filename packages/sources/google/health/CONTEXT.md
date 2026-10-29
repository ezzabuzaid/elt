# source-google-health

A user wants their health data in a store that SQL can read: the data of their Fitbit and Pixel devices, of the Google Health app, and of Apple Health. The Google Health source reads all of it from one Google account through the Google Health API. The words that all of elt uses, for example stream, pass and full refresh, are in the glossary of [elt](../../../elt/CONTEXT.md).

## Language

**Data type**:
One kind of health data that Google Health keeps, for example steps, heart rate or sleep. Each data type is one stream.
_Avoid_: Metric, measure, category

**Point**:
One record of a data type: a sample at one time, or a span from a start time to an end time.
_Avoid_: Sample (a sample is one kind of point), reading, entry

**Measured type**:
A data type that a device records, for example steps or heart rate. Its points have no `name`, and the points of different devices overlap.
_Avoid_: Automatic type, sensor type

**Editable type**:
A data type that a user can edit, for example an exercise, a sleep or a weight. Each point has a `name`, which is its key.
_Avoid_: Manual type, session (a session is an editable point with a start and an end)

**Daily type**:
A data type with one point for each date. Google answers each date, also a date with no data. Thus the source reads it from the membership start date.
_Avoid_: Daily summary, rollup (a rollup is a different family)

**Membership start date**:
The `membershipStartDate` of the profile: the first date of the account in Google Health.
_Avoid_: Account creation date, history start

**Child list**:
A list in a point, for example the stages of a sleep or the splits of an exercise. Each child list is its own stream, keyed by the parent and the position.
_Avoid_: Nested array, sub-record

**Rollup**:
A data type that Google gives only as daily totals: floors, total calories and calories in a heart rate zone.
_Avoid_: Aggregate, summary

**Origin**:
The fields of a point that tell where it came from: `platform`, `recordingMethod`, the device fields and the application that wrote it.
_Avoid_: Source (a source is the elt code that reads an upstream), provenance

**Relay**:
The Google Health iPhone app writes Apple Health data into Google Health. Its points have `platform` `HEALTH_KIT`.
_Avoid_: Import, sync, bridge
