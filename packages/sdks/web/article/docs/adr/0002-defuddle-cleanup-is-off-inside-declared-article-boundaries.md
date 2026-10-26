# Defuddle's cleanup is off inside declared article boundaries

The default options of Defuddle removed parts of real articles. Its exact-selector removal deleted every `aside` and sidebar, which also removed editorial explanations and contributor lists (backlog item 2924). Its link-density scoring deleted the title row of a post when the row linked categories and resources (2927). Its standardization changed the punctuation of the publisher, for example in a linked `HKDF-SHA-256`. On pages without article markup, the same cleanup removed navigation and ads that the article must not keep (2926).

Thus the options follow the markup of the page:

- When the page declares an `article`, a `main` or an ARIA article or main, exact-selector removal is off.
- When a page has no such markup, `.h-entry`, `.hentry` and `.entry` select the post. Inside that post, exact-selector removal and low-score removal are off.
- On a page without either, both cleanups stay on.
- Partial-selector removal and standardization are always off. Asynchronous requests of Defuddle are off.

## Considered Options

- **Keep the default options.** Articles lose asides, title rows and the original punctuation.
- **Turn the cleanup off on every page.** A manual check found Daring Fireball ads in the article.
- **Turn the cleanup off only inside declared boundaries.** This option was selected.

## Consequences

- An aside inside a declared article stays in the article.
- On a page without declared boundaries, navigation, ads and related posts are still removed.
- An incidental `.entry` widget cannot replace a declared article or main element.
- These are options of Defuddle, not rules for a publisher.
