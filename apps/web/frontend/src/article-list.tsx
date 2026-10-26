import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { api } from './api.ts';
import type { ArticleKey } from './app.tsx';
import { shortUrl } from './format.ts';

export function ArticleList({ onOpen }: { onOpen: (key: ArticleKey) => void }) {
  const articles = useQuery({ queryKey: ['articles'], queryFn: api.articles });
  const [filter, setFilter] = useState('');
  const [site, setSite] = useState('');
  const all = articles.data ?? [];
  const sites = [...new Set(all.map(({ inputUrl }) => inputUrl))];
  const needle = filter.trim().toLowerCase();
  const shown = all.filter(
    (article) =>
      (site === '' || article.inputUrl === site) &&
      (needle === '' ||
        `${article.title ?? ''} ${article.pageUrl}`
          .toLowerCase()
          .includes(needle)),
  );
  return (
    <>
      <header className="toolbar">
        <h1>
          Articles <span className="count">{shown.length}</span>
        </h1>
        <select
          value={site}
          aria-label="Site"
          onChange={(event) => setSite(event.target.value)}
        >
          <option value="">All sites</option>
          {sites.map((inputUrl) => (
            <option key={inputUrl} value={inputUrl}>
              {shortUrl(inputUrl)}
            </option>
          ))}
        </select>
        <input
          type="search"
          value={filter}
          placeholder="Filter"
          aria-label="Filter"
          onChange={(event) => setFilter(event.target.value)}
        />
      </header>
      {articles.error !== null && (
        <p className="error">{articles.error.message}</p>
      )}
      <ul className="articles">
        {shown.map((article) => (
          <li key={`${article.inputUrl} ${article.pageUrl}`}>
            <button
              type="button"
              onClick={() =>
                onOpen({ inputUrl: article.inputUrl, pageUrl: article.pageUrl })
              }
            >
              <strong>{article.title ?? shortUrl(article.pageUrl)}</strong>
              <span className="meta">
                {[article.byline, article.publishedTime, article.siteName]
                  .filter((part) => part !== null)
                  .join(' · ')}
              </span>
              {article.excerpt !== null && (
                <span className="excerpt">{article.excerpt}</span>
              )}
              <span className="provenance">
                {shortUrl(article.pageUrl)} · via {shortUrl(article.listingUrl)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
