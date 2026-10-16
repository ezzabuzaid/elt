# Copied: which reader views an import holds yet

A stream's reader view exists only once a pass committed the stream, so "has this stream loaded" is read as "does its view exist" in `sqlite_schema`. Two places read it:

| Source                                                                 | Copy                                                                           | What changed                               | Why                                                              |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------ | ---------------------------------------------------------------- |
| `src/attachment-text.ts` (the views whose rows carry an attachmentRef) | `src/apple-connector.ts`, `publish()` (whether every copied stream has loaded) | One view per statement, and no list built. | The connector's views wait for streams that have not loaded yet. |

This is strike 2 of the Rule of Three. Do not extract a shared module yet.

- Mirror every fix in both copies, and name both files in the commit.
- Extract when a third place asks which reader views exist (backlog item "Third reader-view lookup in AppleConnector: extract it"). AttachmentText is due to move onto elt's hook API (#2618); if it leaves this package, delete this file.
