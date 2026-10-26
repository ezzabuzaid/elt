import { useState } from 'react';

import { ArticleList } from './article-list.tsx';
import { ArticleView } from './article-view.tsx';
import { HistoryPanel } from './history-panel.tsx';
import { SitesPanel } from './sites-panel.tsx';
import { useActivity } from './use-activity.ts';

export type ArticleKey = { inputUrl: string; articleUrl: string };

export function App() {
  const activity = useActivity();
  const [selected, setSelected] = useState<ArticleKey | null>(null);
  return (
    <div className="layout">
      <aside className="sidebar">
        <SitesPanel activity={activity} />
        <HistoryPanel />
      </aside>
      <main className="content">
        {selected === null ? (
          <ArticleList onOpen={setSelected} />
        ) : (
          <ArticleView article={selected} onBack={() => setSelected(null)} />
        )}
      </main>
    </div>
  );
}
