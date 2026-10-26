# The dateline hint is removed before Readability reads the page

Readability 0.6.0 takes an element whose class or id contains `dateline` as a byline, and it does not check the text. On daringfireball.net, `<h6 class="dateline">Wednesday, 21 October 2026</h6>` became the author (backlog item 2945). Readability has no option to change this rule.

Thus, after Defuddle selects the content, `HTMLExtraction` replaces each `dateline` in a class or id with a space, and then Readability reads the DOM. The space stops the text around it from making a new hint: `bydatelineline` must not become `byline`.

## Considered Options

- **Patch the private byline rule of Readability.** The patch depends on code that Readability does not export.
- **Take every author from Defuddle.** Defuddle lost an author that a footer gives with `rel="author"`, and its precedence of metadata is different.
- **Parse dates and reject a byline that is a date.** This needs a date parser for each language.
- **Remove the `dateline` hint from the DOM that Readability reads.** This option was selected.

## Consequences

- Explicit author metadata, `rel` and `itemprop` authors, author and byline classes, and microformats still give the author.
- The selection does not change, because the replacement happens after Defuddle selects the content.
- A page that gives its author only in a dateline element has a null byline.
