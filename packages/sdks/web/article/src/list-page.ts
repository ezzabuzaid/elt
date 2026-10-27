import { JSDOM } from 'jsdom';

/**
 * How sanitized article HTML lists other pages, such as a category, an
 * archive or a blog index, or null when it does not:
 * - cards: two or more top-level article elements that each link another page
 *   hold more than half of its words, as on a blog index;
 * - links: more than a third of its words are the text of links to two or
 *   more other pages of its origin, boilerpipe's link density limit for
 *   content. A link to another origin, as in a roundup, and a link in a data
 *   table do not count.
 */
export function listsPages(content: string, url: string) {
  const dom = new JSDOM(content, { url });
  try {
    const { body } = dom.window.document;
    const page = new URL(url);
    page.hash = '';
    // The page a link names, or null for this page itself or an address that does not parse.
    const target = (link: HTMLAnchorElement) => {
      const named = URL.parse(link.href);
      if (named) named.hash = '';
      return named?.href === page.href ? null : named;
    };
    const total = words(body.textContent);
    const cards = [...body.querySelectorAll('article')].filter(
      (article) =>
        !article.parentElement?.closest('article') &&
        [...article.querySelectorAll<HTMLAnchorElement>('a[href]')].some(
          (link) => target(link) !== null,
        ),
    );
    if (
      cards.length >= 2 &&
      cards.reduce((sum, card) => sum + words(card.textContent), 0) * 2 > total
    )
      return 'cards';
    const pages = new Set<string>();
    let linked = 0;
    for (const link of body.querySelectorAll<HTMLAnchorElement>(
      'a[href]:not(table a)',
    )) {
      const named = target(link);
      if (named?.origin !== page.origin) continue;
      pages.add(named.href);
      linked += words(link.textContent);
    }
    return pages.size >= 2 && linked * 3 > total ? 'links' : null;
  } finally {
    dom.window.close();
  }
}

function words(text: string) {
  return text.split(/\s+/).filter(Boolean).length;
}
