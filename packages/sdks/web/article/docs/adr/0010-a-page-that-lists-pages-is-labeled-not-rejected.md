# A page that lists pages is labeled, not rejected

A crawl hands back every page that matches the caller's URL patterns. On anthropic.com, the category pages, such as `/news/features`, match the same pattern as the articles. Each category page has a title, card headings, excerpts and dates, so the acceptance check keeps it ([ADR 0003](./0003-a-page-of-links-only-is-not-an-article.md)). The articles table then held 8 category pages as articles, and the stages that group articles into events read them as articles (backlog item 3141).

No installed package tells a list from an article. Readability's `isProbablyReaderable` is a score of paragraph length and accepted 6 of 10 live list pages. Defuddle has no field or option for the page type. The open-source extractors that reject list pages (news-please, newspaper4k) also reject real articles: news-please rejected 6 of 10 live articles, among them This Week in Rust, because they do not declare `og:type` article. The hosted extractors that lead the public benchmarks keep the page and label it: Zyte gives a probability for its `article` and `articleList` types, and Diffbot gives the page type `list`.

Thus `HTMLExtraction` and `MarkdownExtraction` give every article a `list` field, and the acceptance check stays as it is. The rule has three steps:

1. A schema.org `CollectionPage`, or its subtypes, gives true. Defuddle reads the JSON-LD of the page.
2. Cards give true. Cards are two or more top-level `article` elements of the sanitized content that each link another page, and they hold more than half of its words, as on a blog index. Cards decide before a declared article, because a blog index often keeps its CMS's declaration: css-tricks.com declares an `Article`, github.blog a `BlogPosting` and smashingmagazine.com/articles/ `og:type` article.
3. Otherwise a declared article decides: a schema.org `Article` type, or its subtypes, gives false, and with no schema.org type, `og:type` article gives false. The schema.org type is the more specific: the-decoder.com's tag pages declare `og:type` article and a `CollectionPage`. With no declared type, the page is a list when more than a third of the words of its sanitized content are the text of links to two or more other pages of its origin. One third is boilerpipe's link density limit for content. Links to other origins and links in data tables do not count.

## Considered Options

- **Reject the list pages.** A page that the rule takes for a list would be lost. A post whose text is all links to its own origin, inside an `article` element, is such a page.
- **Use Readability's `isProbablyReaderable` or a minimum length.** Both rejected real articles and accepted list pages in the live probe.
- **Require `og:type` article, as news-please does.** This Week in Rust, overreacted.io, jvns.ca and paulgraham.com declare no type, or `website`.
- **Count all links, not only links to the same origin.** This Week in Rust has 287 links to other origins, and 64% of its text is link text.
- **Label each article and keep it.** This option was selected.

## Consequences

- No page that the acceptance check keeps is lost. A consumer that wants articles only reads the rows where `list` is false.
- On 32 live pages, every article had at most 8% of its words in links to its own origin, and the anthropic.com category pages had 90% to 95%.
- On 32 live list pages and the articles they link, cards labeled blog.cloudflare.com, deepmind.google/blog, github.blog, smashingmagazine.com/articles/, css-tricks.com and joshwcomeau.com, with 7 to 25 cards and 76% to 100% of the words. No live article had two cards: Defuddle's content of a post stops at the post, so related-post cards after it do not count (backlog item 3210).
- A list page that shows whole posts, such as the home pages of simonwillison.net, kottke.org and daringfireball.net, or gives one article element and long excerpts, such as lwn.net, stays `list: false`.
- A wrong label costs a filter, not a row.
