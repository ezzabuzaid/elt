# Proactive rules

`npx nx run proactive:start` imports Calendar, Mail, Messages, Slack and WhatsApp into
the local Postgres warehouse, evaluates the rules once, acts on new matches, and exits.
It is not a background watcher. A rule that has no saved cursor starts from
the newest position of the warehouse, so it does not act on historical
messages.

## Layout

- `src/main.ts` adds the rules that run. `src/pipeline.ts` lists the connections that the warehouse imports.
- `src/connections/` holds one file for each connection. Each copy names the reader view of its stream `<prefix>_<stream>` (`marts-copy.ts`): readers query it in `marts`, and elt keeps the raw table in `_warehouse`. `src/warehouse.ts` holds the addresses of the loading role and of `agent_reader`, and `src/rules-file.ts` the place of the stored rules.
- `src/engine/` runs the rules: the `Automation` base, the `NotifyAutomation` and `AgentAutomation` actions, the `Automations` runner, and the stored rules: `SqlNotifyRule` and `SqlAgentRule` (`sql-rule.ts`) and `RuleStore` (`rule-store.ts`).
- `src/rules/` holds the rules that are classes, one folder each with its test: `clay-topics/` (two rules that share a base class) and `planning-meetings/`. A rule that one SQL query can express is a stored rule instead (below).

## Stored rules

A stored rule is a rule that a user wrote as data, not as a class: its words,
one SQL query over the marts, and one action, `notify` (a message whose
`{column}` names are filled from the matched row) or `agent` (an instruction
that Codex gets with the matched row, as an `AgentAutomation` does). The rules
are in `~/Library/Application Support/Context Compiler/Proactive/rules.sqlite`,
not in the warehouse: a fresh run makes the warehouse again, and a rule is
what a user wrote, not data that a run derives. The table refuses a row with
no action or with two. `src/main.ts` adds each stored rule by its name beside
the rules in `src/rules/`.

Add a rule from a YAML or JSON file, with exactly one of `notify` and `agent`:

```yaml
name: keyword-text
when: 'a text says proactive:'
sql: SELECT text FROM marts.messages_messages WHERE NOT "isFromMe" AND text ILIKE '%proactive:%'
notify: '{text}'
```

```sh
npx nx run proactive:add-rule /path/to/rule.yaml
```

The target reads the warehouse as it is now, as `agent_reader`, in a read-only
reading. It keeps the rule only when its SQL runs and its message names only
columns that the SQL selects, also when no row is true now. It prints what
the rule finds true now, one line for each row; the rule does not tell those,
since it tells only what becomes true after its first run. A name is
kebab-case, and a name that is kept already is refused. Quote a YAML value
that has `: ` or ends with `:`.

A rule's SQL runs as `agent_reader`, whose `statement_timeout` is 30 seconds
(`infra/init/01-roles.sh`), so a slow rule fails and the others still run.
Postgres inlines a CTE into the query that reads it and can apply an
expensive filter of the outer query before a cheap one of the CTE; a CTE that
picks the few rows an expensive step reads is `MATERIALIZED`. A Careem receipt
rule took 25 seconds without it, because it built the receipt text of all
70,000 Mail messages, and 1 second with it.

A stored rule matches each row that its SQL gives as of `after` and did not
give as of `before`. Rows are compared whole, so a rule chooses what it
compares by the columns it selects: a row whose value changes while it stays
true, such as a running total, matches again. A rule that must tell once
selects what does not change once true, such as the purchase that passed a
limit, not the total so far.

## Rules

Each rule is an automation (`src/engine/automation.ts`): `evaluate` is its eca
condition, which reads the warehouse at two readings and gives what matches in
`after` that did not match in `before`, and `act` does the work for one match and returns a short receipt, which
`Automations` shows as a macOS notification. A `NotifyAutomation` only tells
the user. An `AgentAutomation` gives its instruction and the match to Codex
(its default model for the signed-in account, no user configuration), which may write only in
`outputs/proactive/agent/`; the agent's last message is the receipt. When an
automation fails, in its condition or its action, the failure goes to stderr
and the other automations still act. A failed action is not retried. A run
with a failure exits with code 1.

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
are included. This rule does not read WhatsApp.

Generation uses the installed, signed-in `codex` CLI with its default model,
a read-only sandbox and no user configuration. The prompt asks
for source citations and coverage gaps. An empty or failed generation leaves
the previous file intact and fails the run. Cancelled or past meetings stop
refreshing; existing brief files remain as snapshots. Meetings that exist when
the rule starts are not new, so this does not backfill every future meeting.
The brief tells how fresh each source is at the time it is written: the sync
history keeps no versions, so the action reads it, not the condition.
Calendar access and Full Disk Access for Mail and Messages must already be
granted to the host running the app.

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
must have been loaded by the app. Slack saves periodically. Each rule tells a
message by its Slack link, which names its workspace, conversation and exact
Slack timestamp; a reply present in both streams or a later edit does not
create a second alert for that rule.
Matches carry the Slack link as well as the message text.

`Automations` gives each automation to eca as a rule, and eca walks it from its
saved cursor over each position of the warehouse since the last run. So a run
after a pause tells each match that became true meanwhile, also one that
stopped and became true again.
The cursors are in `proactive.cursors`, by the name each automation is added
with, and a cursor is saved after the actions of its run: a run that stops
between them acts again rather than not at all. A cursor older than the
warehouse's retention starts again from now, and the run counts it as a
failure, so the gap is not silent. Conditions read as `agent_reader`, which the
run grants read access to the numbering in `_warehouse` and nothing else of it.
No schedule or persistent background process is installed.

Run `npx nx run proactive:typecheck` and `npx nx run proactive:test`. Tests require
Docker and use `new Postgres({ environment: process.env })` from
`@zukhruf/testing/postgres` to acquire an isolated PostgreSQL database per test. The project has the `test:docker` tag, so its Nx target starts Node's test
runner with the Docker global setup from `@zukhruf/testing`. The setup starts one test
run and cleans up a killed run. Each test closes its clients and drops its
database when done. The generator and
agent tests use a local executable in place of the authenticated Codex
service, and the automations test one in place of `osascript`; they make no AI
request and show no notification. Each test of the automations and of a rule
loads its rows through a real pipeline into a real Postgres destination and
reads it as of its positions.
