# Phase 05 — Messages

Dependency: 02. Owner: Messages publication module, integration tests and registration entry.

## Work

Read `messages-streams.ts`, `apple-messages-source.ts`, typedstream decoding and Messages fixture tests. Publish views for all 13 streams. Preserve GUID relationships, handle `(id,service)` composite keys, chat/message and message/attachment join tables. Use exported fields exactly: `messages.handle = handles.id AND messages.handleService = handles.service`, likewise `otherHandle/otherHandleService`; `chatHandles` uses `handleId/handleService`. Preserve both keys. Never flatten these joins into a table that silently multiplies message counts.

Preserve native reaction/system/edit/unsend fields, recoverable messages and parts, decoded attributed text, original archived fields and link previews. Existing Apple epoch conversions stay intact. Explain source timestamps versus loaded_at; preserve attachment availability and exported file references.

Use phase 02 publication boundary. No chat timeline UI, search engine, unified conversation model or source parsing refactor.

## Checks and exit

Synthetic chat database → pipeline → Postgres → agent_reader: same handle ID across services, multiple chat memberships/attachments, edit and recoverable message, attributed-only body, unavailable file. Demonstrate join correctness and count messages at their native grain. Verify updates/deletes appear without re-publication.

Put integration tests in `apps/apple/src/*.test.ts` so Nx executes them. Preserve the index’s refs-only contract and reuse its controlled live-check procedure. Run `nx run apple:typecheck` and `nx run apple:test`. Live reader inventory and full historical queries for rare existing edits/unsends/recoverable records; inspect earlier evidence if no instance appears. Never copy personal messages into fixtures or planning evidence.

Exit: all 13 stream views are documented and queryable without lossy flattening.

## Handoff record

Status: complete (2026-09-30). Changes: `apps/apple/src/sources/apple-messages/messages-streams.ts` — loader kinds carry their provenance phrase, tables carry their chat.db names, stream descriptions state the `(id, service)` handle joins and message-grain counting for the many-to-many streams. Equivalence with HEAD checked with descriptions stripped.

Checks (2026-09-30): `nx run elt:test` 22 pass, `nx run elt-postgresql:test` 35 pass, `nx run google:test` 40 pass, `nx run apple:test` 77 pass; `typecheck` (with lint) for elt, elt-postgresql, google and apple. Reader test (`index.test.ts`): 13 views fully described; the same address on SMS and iMessage stays two handles, joined on both keys (5 iMessage, 1 SMS); a message in two chats joins twice but counts once; archived-only body decoded; two edits; recoverable message; exact bytes for a local attachment, NULL for an offloaded one; raw denial.

Live evidence (full history): 12,594 messages; handle join on both keys 11,701 SMS and 343 iMessage; 12,502 chat links for 12,502 distinct messages; 6 edits, 4 recoverable, 22 link previews; 41 attachments, 6 with local files.
