# Proactive rules

`npx nx run proactive:start` imports Calendar, Mail, Messages and Slack into the local
Postgres warehouse, evaluates the rules once, acts on new matches, and exits.
It is not a background watcher. The first successful import establishes a
baseline without acting on historical messages.

Each rule is an automation (`automation.ts`): `evaluate` reads the warehouse,
and `act` does the work for one new match and returns a short receipt, which
`Automations` shows as a macOS notification. A `NotifyAutomation` only tells
the user. An `AgentAutomation` gives its instruction and the match to Codex
(its default model for the signed-in account, no user configuration), which may write only in
`outputs/proactive/agent/`; the agent's last message is the receipt. When an
automation fails, in its condition or its action, the failure goes to stderr
and the other automations still act. A failed action is not retried. A run
with a failure exits with code 1.

**CareemCalories:** when a Careem delivery receipt arrives in Mail, the agent
logs the calorie intake of the order in `outputs/proactive/agent/food-log.md`:
one row per order with the date, restaurant, dishes and estimated kcal. Each
order ID acts once. The receipt names the restaurant and the dishes, but no
calories, so the agent estimates them. Receipts from July 2026 on have no
text part; the rule gives the agent the text of the HTML part. A receipt
reaches the warehouse only after Mail.app fetched it.

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

Generation uses the installed, signed-in `codex` CLI with its default model,
a read-only sandbox and no user configuration. The prompt asks
for source citations and coverage gaps. An empty or failed generation leaves
the previous file intact and fails the run. Cancelled or past meetings stop
refreshing; existing brief files remain as snapshots. Existing meetings on the
first import form the baseline, so this does not backfill every future meeting.
Calendar access and Full Disk Access for Mail and Messages must already be
granted to the host running the app.

Two rules read the Arab Bank SMS in Messages, by the time of each SMS in
Amman:

- **SpendSpike:** the card purchases of an ISO week pass twice the median of
  the 8 weeks before it. A week without purchases counts as 0 JOD. One-time
  codes, credits and transfers are not purchases. Each week notifies once.
- **MissingMidMonthCredit:** a credit of 1000 JOD or more is due on days 13
  to 17 of each month. When day 18 starts and no such credit came on day 13
  or later, the month notifies once. Day 18 starts when the import holds a
  message from day 18, so an import that is behind does not notify. A credit
  on days 7 to 12 does not count, because a different credit of the same
  size arrives then; thus a mid-month credit that comes early notifies too.

Both Slack rules require Clay McCoy as the sender in Delivery Associates:

- **ClayBdAgentMessages:** messages about the business development agent,
  including its proposal workflow, team composition, relevant-experience
  section and Generate Section control in the Ezz/Mo/Clay work conversation.
- **ClayDataHubMcpMessages:** messages about the Data Hub MCP, connector or
  plugin, including its semantic layer, case-study writer and colleague-bio
  skills in that work conversation.

Both use explicit topic phrases and recognizable follow-ups. A follow-up such
as "still missing elements" inherits its loaded thread's context, or the
preceding discussion in the same conversation with at most a four-hour gap.
Other participants can establish context; only Clay's messages notify.
Unrelated top-level subjects reset conversation context. Threads keep their
parent's topic even across intervening replies. A message
that explicitly names a topic is checked against that topic rather than
inheriting the preceding one. A message about both topics can match both rules.

This is deterministic text matching, not an AI classifier. An unrecognized
paraphrase or a follow-up without a topic anchor in the loaded history may
not match. Neither Clay's identity nor the work conversation alone is enough
to trigger a notification.

The conditions were grounded in the Slack import synced on 9 October 2026:
Clay's BD-agent feedback of 15 and 21 September; Data Hub MCP requests of
7–8 October; and his LIH brief comparison and confirmation of 9 October.
The recent Data Hub Claude session identifies the work as MCP, not MCB:
project-brief access through SQL and exporting BD prompts for proposal skills.

Only messages saved by Slack on this Mac are available, and thread replies
must have been loaded by the app. Slack saves periodically. Each rule keys a
message by workspace, conversation and exact Slack timestamp; a reply present
in both streams or a later edit does not create a second alert for that rule.
Matches carry the Slack link as well as the message text.

Rules keep their keys only during one run. A restart takes a new baseline from
the warehouse before refreshing. No schedule or persistent background process
is installed.

Run `npx nx run proactive:typecheck` and `npx nx run proactive:test`. Tests use
the already-running local Postgres server (or `TEST_DATABASE_URL`), create one
temporary database per database test and drop it when done. The generator and
agent tests use a local executable in place of the authenticated Codex
service, and the automations test one in place of `osascript`; they make no AI
request and show no notification.
