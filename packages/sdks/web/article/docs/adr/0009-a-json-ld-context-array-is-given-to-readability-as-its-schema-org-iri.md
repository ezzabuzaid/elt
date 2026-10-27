# A JSON-LD context array is given to Readability as its schema.org IRI

Readability 0.6.0 reads JSON-LD only when `@context` is a string or an object with a `@vocab`. JSON-LD 1.1 also allows an array of contexts. Fortune declares `"@context": ["https://schema.org", {"stnMeta": …}]` on each article, so Readability skipped the whole `NewsArticle`. The article had no `publishedTime`, and its title came from `<title>` with " | Fortune" at the end (backlog item 3148). Readability has no option for this. The open pull request mozilla/readability#1030 reads context arrays.

Thus, after Defuddle selects the content, `HTMLExtraction` replaces an array `@context` that contains the schema.org IRI with that IRI, and then Readability reads the DOM. A script that is not JSON stays as it is.

## Considered Options

- **Read `datePublished` from Defuddle's `schemaOrgData`.** The SDK must then choose the article object itself, and only the date changes; the title keeps the site name.
- **Take `published` from Defuddle.** When a page declares no date, Defuddle takes a date from the text near the title and adds a time of 00:00 UTC. The metadata then has a value that the page does not supply.
- **Give Readability the schema.org IRI in place of the array.** This option was selected.

## Consequences

- Readability reads `datePublished`, `headline`, `author`, `description` and the publisher from the same JSON-LD rules for a string context and for an array context.
- The other entries of the array define terms that are not schema.org terms, so Readability does not use them.
- When Readability reads context arrays, remove the replacement.
