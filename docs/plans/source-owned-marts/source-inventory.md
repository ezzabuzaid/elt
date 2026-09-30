# Apple publication inventory

This inventory comes from source definitions, not a live warehouse count. The six Apple sources define **103 streams**. Each source owns its reader definitions in the shared `marts` schema; reader names must distinguish sources. Raw tables remain in the source schemas. Do not merge native grains into a generic document model.

## Notes — 5

`accounts`, `folders`, `notes`, `inlineAttachments`, `attachments`.

Accounts, folders and notes have source identifiers. Folders have parent relationships. Recently Deleted (folder type 1) remains exported. Locked or unavailable bodies are NULL, not empty text. Markdown uses `attachment:<id>` links and native note links. Attachment parents preserve scan hierarchies. Tables and links can have no file; metadata availability does not imply readable bytes. Native OCR, handwriting and transcripts remain separate from any destination parsing.

Evidence: `apps/apple/src/sources/apple-notes/apple-notes-source.ts`, `notes-stream.ts`, `folders-stream.ts`, `attachments-stream.ts`, `inline-attachments-stream.ts`. These stream schemas already contain substantial row and field descriptions; reader definitions still must explain physical reader joins.

## Calendar — 11

`accounts`, `calendars`, `events`, `attendees`, `alarms`, `recurrenceRules`, `recurrenceRuleValues`, `icsComponents`, `icsProperties`, `icsParameters`, `icsAttachments`.

Events represent occurrences, not series. Their eventId is JSON `[calendarId,calendarItemId,occurrenceKey]`, with NULL/nonrecurring, local-date/recurring-all-day or UTC-timestamp/recurring-timed occurrence keys. nativeEventId and mutable startAt are not replacements for this identity. Related EventKit rows join `eventId`; ICS rows use `calendarId`, `calendarItemId`, component and property identifiers. ICS exports can describe series beyond the event window. `icsComponents.eventId` exists only for exact nonrecurring VEVENT masters; recurring components retain NULL and relate at `(calendarId,calendarItemId)` grain. Content coverage is occurrences overlapping `[startAt, endAt)`; zero-duration events must start inside it. Listings are unfiltered. All-day date fields preserve calendar dates separately from UTC instants. Preserve recurrence, ordered parameters and vendor properties. Private ICS export can be unavailable. Attachment bytes can be inline, remote or unavailable.

Evidence: `apps/apple/src/sources/apple-calendar/apple-calendar-source.ts`, `ics-records.ts`, `calendar-script.ts`, and `apps/apple/src/sources/eventkit-schema.ts`. Coverage descriptions are source-level; generated EventKit schemas mostly provide types, not reader semantics.

## Reminders — 8

`accounts`, `lists`, `reminders`, `dateComponents`, `attendees`, `alarms`, `recurrenceRules`, `recurrenceRuleValues`.

Related rows join `reminderId`, lists join `listId`. Start and due dates are native component sets with calendar, time zone and leap-month fields. Missing components must remain missing; do not manufacture a due timestamp. Completion flag, completion time and priority retain their native meanings. Preserve recurrence and alarm grains.

Evidence: `apps/apple/src/sources/apple-reminders/apple-reminders-source.ts`, `reminders-script.ts`, and `apps/apple/src/sources/eventkit-schema.ts`.

## Contacts — 24

`containers`, `groups`, `groupMembers`, `groupSubgroups`, `contacts`, `notes`, `alternateBirthdays`, `phoneNumbers`, `emailAddresses`, `postalAddresses`, `urlAddresses`, `socialProfiles`, `messagingAddresses`, `relatedNames`, `contactDates`, `calendarUris`, `addressingGrammars`, `likenesses`, `alertTones`, `customPropertyValues`, `remoteLocations`, `unknownProperties`, `distributionListConfigs`, `images`.

Exported identifiers name native records, not unified people. Preserve labeled values, ordering, nullable flags, nested groups and distribution-list address selections. Birthday year NULL represents native unknown-year sentinel 1604; non-Gregorian components remain separate. Images have key `(contactId, kind)` and managed file references. `storage` describes native inline/external storage, and `externalId` is the source storage identifier; neither replaces exported attachmentRef. Unknown vCard properties remain exact lines. Native archive JSON and Base64 fields must remain identifiable without inferred meaning.

Evidence: `apps/apple/src/sources/apple-contacts/contacts-streams.ts`, `apple-contacts-source.ts`. Generated schemas describe types but generally need authored row-grain, join and field comments for readers.

## Messages — 13

`chats`, `handles`, `chatLookups`, `chatServices`, `chatHandles`, `messages`, `chatMessages`, `linkPreviews`, `messageEdits`, `recoverableMessages`, `recoverableMessageParts`, `attachments`, `messageAttachments`.

GUID relationships survive local ROWID rebuilds. Handles have composite key `(id, service)`; joins must use both. Messages exports `handle/handleService` and `otherHandle/otherHandleService`; chatHandles exports `handleId/handleService`. Chat/message and message/attachment relations are many-to-many: flattening them multiplies counts. Preserve edits, recoverable links, reactions and system-message fields. Apple epoch nanoseconds or seconds are already converted by extraction; do not convert again. Attributed text supplies body text when ordinary text is unavailable; archive fields remain separately retained. File availability can change independently of message timestamps.

Evidence: `apps/apple/src/sources/apple-messages/messages-streams.ts`, `apple-messages-source.ts`, `typedstream.ts`.

## Mail — 42

29 table-backed streams:

`messages`, `mailboxes`, `addresses`, `recipients`, `indexedAttachments`, `messageMailboxes`, `serverMessages`, `serverMessageMailboxes`, `conversations`, `conversationMessages`, `messageReferences`, `messageGlobalData`, `subjects`, `summaries`, `generatedSummaries`, `messageMetadata`, `dataDetectionResults`, `richLinks`, `messageRichLinks`, `protectedMessageData`, `brandIndicators`, `brandIndicatorEvidence`, `addressMetadata`, `businesses`, `businessAddresses`, `businessCategories`, `senders`, `senderAddresses`, `events`.

13 supplemental streams:

`accounts`, `smtpServers`, `mailboxProperties`, `rules`, `ruleConditions`, `smartMailboxes`, `smartMailboxConditions`, `signatures`, `configuration`, `messageFiles`, `messageHeaders`, `messageParts`, `attachments`.

Mail index identifiers are local. Subject, summary, sender and recipient fields need explicit joins; mailbox membership is a separate grain. MIME parts use `(messageId, partId)`; parent links join `(messageId,parentPartId)` to those same keys, and rule conditions join `(scope,ownerId)` to rules `(scope,id)`; headers preserve position and raw lines. Index-only attachments can precede MIME downloads. Missing and partial message files remain explicit. Confirmed Unix dates are converted by extraction; unverified native date numbers retain `Raw` suffix and must not be interpreted as UTC. Native flags, rule conditions and configuration property JSON require honest descriptions; unknown meanings remain unknown.

Evidence: `apps/apple/src/sources/apple-mail/mail-tables.ts`, `apple-mail-source.ts`, and `apps/apple/src/platform/macos/mail-mime.ts`.

## Lifecycle and acceptance

`apps/apple/src/pipeline.ts` discovers streams and loads incremental snapshots into `apple_<source>.raw_<stream>`. File streams add `attachmentRef` backed by `outputs/apple-<source>-files`: an absolute destination-managed, content-addressed path scoped per file field. It is not a source filename, portable URL or parsed content. NULL means no exported bytes for that row; source fields explain why where known. Committed-row reconciliation removes obsolete managed files. The current exporter has no parsed file content or database byte column (`7514de0`); native text/Markdown/OCR/transcript fields remain source data. Checkpoints are per source. `apps/apple/src/main.ts` installs history and watches; it currently publishes no content views. Calendar attachment OAuth is requested during pipeline construction.

All non-Calendar sources declare accessible local-store coverage, without a date filter; this does not guarantee cloud completeness. Source coverage descriptions do not replace reader table and column descriptions. Preserve mechanically documented native fields where semantics remain unknown, explicitly labeling the uncertainty rather than guessing or silently omitting them.

Publication checks must prove exact described columns, documented grain and joins, typed dates/nulls, reader grants, file references and incremental updates/deletions. Reuse connector fixtures; test reader contracts rather than duplicating extraction tests. Widen live probes to full available history before calling a feature unverified. No pipeline execution, service startup or production changes are authorized by this planning file.
