# Proactive rules

`npx nx run proactive:start` imports Calendar, Mail, Messages and Slack into the local
Postgres warehouse, evaluates the rules once, displays macOS notifications for
new matches, and exits. It is not a background watcher. The first successful
import establishes a baseline without notifying about historical messages.

**PlanningMeetings:** when a new future planning meeting is imported, write a
brief with recent decisions, unresolved questions, relevant conversations and
the joining link. Changes to the meeting or its related conversations refresh
the same Markdown file in `outputs/proactive/meeting-briefs/`. The notification
and terminal output include its path. Unchanged imports stay quiet.

The rule recognizes planning, prep, preparation, formulation, kickoff,
strategy or agenda in a timed meeting's title (also تخطيط and تحضير). It reads
the next year of Calendar occurrences, excludes subscribed calendars and
cancelled events, and considers the last 30 days of conversation history.
Distinctive title words or the event URL select Slack threads, Messages chats
and Mail conversations. A generic title such as “Planning meeting” produces
a Calendar-only brief unless its URL occurs in a conversation. Matching is
literal, so paraphrases can be missed; the generator filters unrelated material
inside selected conversations. Only locally available messages and bodies
are included. WhatsApp is not part of this app's pipeline.

Generation uses the installed, signed-in `codex` CLI with `gpt-6.1-sol`,
a read-only sandbox and no user configuration. The prompt asks
for source citations and coverage gaps. An empty or failed generation leaves
the previous file intact and fails the run. Cancelled or past meetings stop
refreshing; existing brief files remain as snapshots. Existing meetings on the
first import form the baseline, so this does not backfill every future meeting.
Calendar access and Full Disk Access for Mail and Messages must already be
granted to the host running the app.

Rules keep their keys only during one run. A restart takes a new baseline from
the warehouse before refreshing, as the other proactive rules do. No schedule
or persistent background process is installed.

Run `npx nx run proactive:typecheck` and `npx nx run proactive:test`. Tests use
the already-running local Postgres server (or `TEST_DATABASE_URL`), create one
temporary database per database test and drop it when done. The generator test
uses a local executable in place of the authenticated Codex service; it makes
no AI request.
