import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { api } from './api.ts';
import type { ArticleKey } from './app.tsx';

const tabs = ['Reader', 'Markdown', 'Text'] as const;

export function ArticleView({
  article: { inputUrl, pageUrl },
  onBack,
}: {
  article: ArticleKey;
  onBack: () => void;
}) {
  const [tab, setTab] = useState<(typeof tabs)[number]>('Reader');
  const article = useQuery({
    queryKey: ['article', inputUrl, pageUrl],
    queryFn: () => api.article(inputUrl, pageUrl),
  });
  const { data } = article;
  return (
    <article className="reader">
      <header className="toolbar">
        <button type="button" onClick={onBack}>
          ← Articles
        </button>
        <nav className="tabs">
          {tabs.map((name) => (
            <button
              key={name}
              type="button"
              aria-pressed={tab === name}
              onClick={() => setTab(name)}
            >
              {name}
            </button>
          ))}
        </nav>
      </header>
      {data === undefined ? (
        article.error === null ? (
          <div className="skeleton reader-skeleton" aria-busy="true">
            <span />
            <span />
            <span />
          </div>
        ) : (
          <p className="error">{article.error.message}</p>
        )
      ) : (
        <>
          <h1>{data.title ?? pageUrl}</h1>
          <dl className="fields">
            {(
              [
                ['Byline', data.byline],
                ['Published', data.publishedTime],
                ['Site', data.siteName],
                ['Language', data.lang],
                ['Direction', data.dir],
                ['Length', `${data.length.toLocaleString()} characters`],
                ['Page', data.pageUrl],
                ['Fetched', data.url],
                ['Canonical', data.canonicalUrl],
                ['Listing', data.listingUrl],
                ['Last modified', data.lastModified],
                ['Input', data.inputUrl],
              ] as const
            )
              .filter(([, value]) => value !== null)
              .map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>
                    {value?.startsWith('http') ? (
                      <a href={value} target="_blank" rel="noreferrer">
                        {value}
                      </a>
                    ) : (
                      value
                    )}
                  </dd>
                </div>
              ))}
          </dl>
          {tab === 'Reader' && (
            <div
              className="body prose"
              lang={data.lang ?? undefined}
              dir={data.dir ?? undefined}
              // The source stores sanitized article HTML in content.
              dangerouslySetInnerHTML={{
                __html: withoutRepeatedTitle(data.content, data.title),
              }}
            />
          )}
          {tab === 'Markdown' && <pre className="body">{data.markdown}</pre>}
          {tab === 'Text' && <pre className="body">{data.textContent}</pre>}
        </>
      )}
    </article>
  );
}

// Extracted article HTML usually opens with the same heading the page
// already shows above the fields.
function withoutRepeatedTitle(content: string, title: string | null): string {
  const parsed = new DOMParser().parseFromString(content, 'text/html');
  const heading = parsed.querySelector('h1');
  if (title !== null && heading?.textContent.trim() === title.trim())
    heading.remove();
  return parsed.body.innerHTML;
}
