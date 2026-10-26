# Markdown is converted from the sanitized HTML

An HTML article must also give Markdown. The HTML, the Markdown and the text must show the same selection, and the Markdown must keep tables, links and the exact text of code.

Thus `HTMLExtraction` converts the Markdown with `NodeHtmlMarkdown.translate` after DOMPurify sanitizes the HTML. Code blocks are indented, so code that contains backtick fences stays exact. In prose, the converter escapes `&` and `<`, so a literal HTML example stays text when the Markdown is rendered. Code spans and code blocks are not escaped.

## Considered Options

- **The integrated Markdown of Defuddle.** It converts before the final sanitization. Its standalone export needs a browser `document` in Node.
- **Turndown.** It has no tables, and its GFM plugin does not escape a pipe in a table cell.
- **node-html-markdown on the sanitized HTML.** This option was selected.

## Consequences

- The HTML, the Markdown and the text come from the same sanitized selection.
- A code block loses its language annotation.
- An `&` in prose shows as `&amp;` in the Markdown source. Backlog item 2967 records this.
- The package has no Markdown translator of its own.
