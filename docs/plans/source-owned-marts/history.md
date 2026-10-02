# History and decisions

Reviewed on 2026-09-29. This is historical evidence, not a claim about current implementation.

## Review coverage

The local Codex state index (`~/.codex/state_5.sqlite`, opened read-only) contains 61 sessions whose working directory matches this repository, including 21 archived sessions. All 61 indexed transcript paths exist. The count includes Guardian approval transcripts, this planning chat, and its subagents. The review scanned every indexed transcript for relevant user messages and source/publication discussions, then read the complete relevant conversation messages in the threads below. Guardian transcripts repeat parent dialogue and are not independent user decisions.

No other indexed working directory has this repository's absolute path in its first user message or preview. The review covers local Codex history; it cannot establish completeness for deleted transcripts, unindexed external conversations, or another machine. It does not claim to have reviewed all unrelated conversations on the account.

## Explicit user decisions

| Decision                                                                                                            | Evidence                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The consumer reads data only when explicitly asked. The service owns collection and refresh.                        | Thread `01a0e255-b482-7f51-96f5-dff1fb92a303`, transcript lines 78, 91, 104: “only when expliclity asked”; acceptance of “Starting pipelines, refreshing data, and managing connectors belong to the service.”         |
| Discover meaning from the database; keep the skill small.                                                           | Same thread, line 162: “100%. the point is to be able to drive things from db as much as possiple.”                                                                                                                    |
| Regenerate stored output; do not preserve old records through compatibility design.                                 | Same thread, line 533: “I do not care about current records. the etl/elt designed to be regenerated”.                                                                                                                  |
| Use the skill with direct database access rather than requiring an MCP transport.                                   | Same thread, lines 431–444: “why we need mcp where we have skill?”, followed by authorization to update the skill.                                                                                                     |
| Keep Apple connector/domain implementation in the Apple app; reusable ELT belongs in packages.                      | Thread `01a0c3a0-c8a5-7cc2-bae9-4e7f9950fa5a`, line 412: “all apple related connectos should live in apps/apple only the elt lib in packages/elt”.                                                                     |
| Keep Apple and Google separate apps with plain connector lists and short direct loops.                              | Thread `01a0dcef-24f2-7240-826e-dbeba19034cb`; memory registry `MEMORY.md:4090–4095` and the September 27 connector-registration/simple-connector-loop notes capture the later correction rejecting the shared runner. |
| Prefer inline source schema declarations over a speculative shared schema-builder module.                           | Thread `01a0e2d8-18f6-7743-99b9-a39b6b2ede40`, lines 85–98: “I was thinking just inling it”, then authorization to remove the helper.                                                                                  |
| Finish splitting hardcoded Google marts per source. This session creates a multi-session plan and phase files only. | Current thread `01a0ee66-96b0-7360-84b0-1d97891c642e`, line 155 and subsequent planning request.                                                                                                                       |

## Source ownership versus SQL schema names

The historical proposal in thread `01a0e255-b482-7f51-96f5-dff1fb92a303`, line 193, explicitly describes one raw schema per connector and ordinary reader views in shared `marts`. It says to author descriptions alongside the view definitions, and to prove Notes first before other Apple sources.

This is an assistant proposal, not an explicit user decision about physical reader schemas. The reviewed history contains no user instruction requiring a separate reader SQL schema per source. The current request establishes source ownership and removal of Google hardcoding. Keeping shared `marts` while making view definitions/publication source-owned was the history-consistent recommendation. The user explicitly selected it in the current planning chat on 2026-09-29. Do not label separate reader schemas an already agreed requirement.

The same historical thread, line 282, distinguishes source meaning in connector JSON Schema from additional meaning introduced by a mart transformation. This is a useful implementation principle: do not duplicate source descriptions merely to publish a reader surface.

## Relevant thread inventory

| Thread                                 | Topic and evidence                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------ |
| `01a0c35d-7784-7183-8a91-bd02abfbcbc6` | Adding sources and native Apple coverage; attachment feasibility discussion at line 746.   |
| `01a0c3a0-c8a5-7cc2-bae9-4e7f9950fa5a` | Apple app/domain boundaries and EventKit ownership.                                        |
| `01a0c3de-e7e7-7cd0-900d-f0729e4482c0` | Source-owned watching; historical implementation report at lines 205 and 500.              |
| `01a0dcef-24f2-7240-826e-dbeba19034cb` | Apple Mail and simplified connector registration; runner rejection is preserved in memory. |
| `01a0e255-4636-7043-b597-aa71f3411dca` | Continued Apple Mail/shared replication validation.                                        |
| `01a0e255-b482-7f51-96f5-dff1fb92a303` | Main database discovery/marts/skill design discussion, lines 65–618.                       |
| `01a0e2d8-18f6-7743-99b9-a39b6b2ede40` | Inline source schema correction, lines 52–98.                                              |
| `01a0ec52-3d30-75a3-92b4-44e22ab043d2` | Double-check metadata propagation before further work.                                     |
| `01a0ec54-70e2-78e1-bb3d-f10382728bd7` | Shared PostgreSQL view-publisher commit; historical report at line 44.                     |
| `01a0ec59-7788-7592-ace3-500cad5284e9` | Sync status and extraction coverage; completion report at line 280.                        |
| `01a0ee4e-9c64-7281-b686-4cffd8485c84` | Move query-warehouse skill into this repository.                                           |
| `01a0ee66-96b0-7360-84b0-1d97891c642e` | Current explanation, correction, and planning request.                                     |

Archived transcript evidence is under `~/.codex/archived_sessions/`; active transcript evidence is under `~/.codex/sessions/2026/09/`. Locate a file by its thread UUID; some forked filenames contain two UUIDs. The index's `rollout_path` is authoritative for the exact file.

## Scope implications

Finish source-owned reader publication and source-neutral shared discovery/permissions/metadata. Preserve existing direct source execution. Watch-service implementation, new attachment extraction/parser features, app convergence, and a new generic runner are not established requirements of this marts plan. Existing extracted attachment metadata/content must remain discoverable and accurately described; do not promise unsupported native fields.
