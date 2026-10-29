# Apple Clock source

A host wants the saved objects of the Clock app in a store that SQL can read: alarms, timers, world clocks and the stopwatch. The Clock source reads the three files where Clock and its daemon `mobiletimerd` keep them, and it does not start Clock. The words that all of elt uses, for example stream, snapshot stream, checkpoint and pass, are in the glossary of [elt](../../../elt/CONTEXT.md).

## Language

**Store**:
One of the three files that the source reads: the MobileTimer database, the city preferences or the stopwatch preferences. A store fails only its own streams.
_Avoid_: Database (only one store is a database), file

**MobileTimer database**:
The Core Data SQLite file `local.sqlite` in the group container of `mobiletimerd`. It holds alarms, timers, timer durations, sounds and the regional and diagnostic tables.
_Avoid_: Clock database, analytics database (`analytics.sqlite` is a different file that the source does not read)

**City preferences**:
The property list `com.apple.mobiletimer.plist` in the container of Clock. It holds the saved world clocks, in order.
_Avoid_: World clock store

**Stopwatch preferences**:
The property list `com.apple.mobiletimerd.plist`. It holds the current stopwatch and its completed laps.
_Avoid_: Stopwatch history (it holds no past sessions)

**Version probe**:
The value that a watch reads each second to see a change of one store: the `data_version` of the database, or the inode, size and modification time of a preference file.
_Avoid_: Fingerprint

**Saved deadline**:
The fire time that Clock stores for a running timer. The source gives it, not a countdown.
_Avoid_: Remaining time (a paused timer stores remaining seconds)
