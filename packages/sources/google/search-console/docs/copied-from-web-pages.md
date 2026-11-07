# Copied from source-web-pages

| Source                                       | Copy              | Changes |
| -------------------------------------------- | ----------------- | ------- |
| `packages/sources/web/pages/src/due-time.ts` | `src/due-time.ts` | None.   |

Both sources wake a stream when a due time that a read learned passes (elt ADR 0020). Both also reset the due times of a stream in `open()`, when a read of it starts, so a check during the read does not wake the stream again for a due time that the read already met. The reset is the code of each source, not of `DueTime`. The web pages source deletes the due times, so the stream is not due until each crawl of its inputs ended. Search Console sets the due time to the next poll, so an inspection pass that fails is tried again then.

The reason for the copy is the Rule of Three: code that a second place needs is copied, and it is extracted only when a third place needs it. When a third source watches a due time, `DueTime` moves into a package that the three sources share (backlog #3921). Until then, a fix in one copy is made in the other copy too, and the commit names both files.
