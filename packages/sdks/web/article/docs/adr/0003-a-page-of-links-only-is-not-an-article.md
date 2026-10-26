# A page of links only is not an article

Some pages have no article: a menu, a tag index or a list of links. A content selector still returns a body for them. The SDK must reject such a body, but it must keep a short linked post, a plain `div` of prose and a data table.

Thus `HTMLExtraction` applies an acceptance check after sanitization. It removes, in a copy of the content, every link outside `article`, `[role="article"]` and `table`. When no text remains, the page has no article and the extraction returns null. Before selection, it removes the navigation landmarks `nav` and `[role="navigation"]`.

## Considered Options

- **Readability's `isProbablyReaderable`.** Its check counts only some tags, so it rejected plain `div` prose and data tables (backlog item 2915).
- **A minimum length of prose.** It rejects short linked posts.
- **Prose must remain after the links outside an article or a table are removed.** This option was selected.

## Consequences

- An unmarked page of links only gives null (backlog item 2917).
- A short post with one sentence of prose is an article, also when it links mostly to other pages.
- A declared article whose text is all links, and a table of links, are articles.
- The check removes links only in its copy. The returned HTML and text keep their links.
