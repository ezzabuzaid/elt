import { JSDOM } from 'jsdom';

/**
 * Whether sanitized article HTML lists other pages of the page's origin, such
 * as a category or an archive: more than a third of its words are the text of
 * links to two or more of those pages, boilerpipe's link density limit for
 * content. A link to another origin, as in a roundup, and a link in a data
 * table are not a listed page.
 */
export function listsPages(content: string, url: string) {
  const dom = new JSDOM(content, { url });
  try {
    const page = new URL(url);
    page.hash = '';
    const pages = new Set<string>();
    let linked = 0;
    for (const link of dom.window.document.querySelectorAll<HTMLAnchorElement>(
      'a[href]:not(table a)',
    )) {
      const target = URL.parse(link.href);
      if (target?.origin !== page.origin) continue;
      target.hash = '';
      if (target.href === page.href) continue;
      pages.add(target.href);
      linked += words(link.textContent);
    }
    return (
      pages.size >= 2 &&
      linked * 3 > words(dom.window.document.body.textContent)
    );
  } finally {
    dom.window.close();
  }
}

function words(text: string) {
  return text.split(/\s+/).filter(Boolean).length;
}
