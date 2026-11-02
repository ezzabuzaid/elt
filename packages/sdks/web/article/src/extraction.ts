export type ArticlePage = {
  readonly url: string;
  readonly body: string | Uint8Array;
  readonly contentType: string | undefined;
  /** The response's Link header (RFC 8288), where a page can declare its canonical URL and its language copies. */
  readonly link: string | undefined;
};

/** One language copy of a page, as the page declares it with rel="alternate" hreflang: its language code, lower case, and its URL. */
export type LocalizedVersion = {
  readonly language: string;
  readonly url: string;
};

export type Article = {
  readonly url: string;
  readonly canonicalUrl: string | null;
  /** The language copies that the page declares in its head and its Link header, itself included, in the order declared, without repeats; empty when it declares none. */
  readonly localizedVersions: readonly LocalizedVersion[];
  readonly title: string | null | undefined;
  readonly byline: string | null | undefined;
  readonly excerpt: string | null | undefined;
  readonly siteName: string | null | undefined;
  readonly lang: string | null | undefined;
  readonly dir: string | null | undefined;
  readonly publishedTime: string | null | undefined;
  /** The publication time that the page declares or, failing that, shows as text near its title, in ISO 8601 UTC; null when none parses. */
  readonly inferredPublished: string | null;
  readonly content: string;
  readonly markdown: string;
  readonly textContent: string;
  readonly length: number;
  /** The page lists other pages, such as a category, an archive or a blog index, rather than being one article. */
  readonly list: boolean;
};

export abstract class Extraction {
  abstract readonly mediaTypes: readonly string[];

  abstract extract(
    page: ArticlePage,
    signal: AbortSignal,
  ): Promise<Article | null>;
}
