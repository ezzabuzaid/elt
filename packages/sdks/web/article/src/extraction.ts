export type ArticlePage = {
  readonly url: string;
  readonly body: string | Buffer;
  readonly contentType: string | undefined;
};

export type Article = {
  readonly url: string;
  readonly canonicalUrl: string | null;
  readonly title: string | null | undefined;
  readonly byline: string | null | undefined;
  readonly excerpt: string | null | undefined;
  readonly siteName: string | null | undefined;
  readonly lang: string | null | undefined;
  readonly dir: string | null | undefined;
  readonly publishedTime: string | null | undefined;
  readonly content: string;
  readonly markdown: string;
  readonly textContent: string;
  readonly length: number;
};

export abstract class Extraction {
  abstract extract(
    page: ArticlePage,
    signal: AbortSignal,
  ): Promise<Article | null>;
}
