# Front matter is data, read as YAML 1.2

Native Markdown can start with front matter that gives the title, the author, the date and the description. The SDK must keep a date as the source text, as it does for HTML metadata. Front matter comes from the publisher, so it must not run as code.

Thus `MarkdownExtraction` splits the front matter with gray-matter and gives its YAML to the YAML 1.2 parser of the `yaml` package. A date stays a string. The JavaScript engine of gray-matter throws, so executable front matter fails the extraction.

## Considered Options

- **`front-matter` 4.0.2.** Its published callable type failed under the NodeNext setup of the package.
- **gray-matter with its default YAML engine.** It changes a publication date into a `Date` object.
- **gray-matter with its default JavaScript engine.** It runs code from the publisher.
- **gray-matter with the YAML 1.2 engine, and no JavaScript engine.** This option was selected.

## Consequences

- `publishedTime` from front matter is the source text, not a parsed date.
- Only `title`, `author`, `date` and `description` are read. Other front matter is ignored.
- Executable front matter fails the Markdown extraction. When the extraction chain prefers Markdown and also reads HTML, the reader then requests the page as HTML only. Otherwise the page fails with an `ArticleError`.
