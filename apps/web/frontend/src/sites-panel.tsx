import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { Activity, Settings } from '../../src/contract.ts';
import { api } from './api.ts';
import { EditableList } from './editable-list.tsx';

export function SitesPanel({ activity }: { activity: Activity }) {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const save = useMutation({
    mutationFn: api.saveSettings,
    onSuccess: (saved) => queryClient.setQueryData(['settings'], saved),
  });
  const sync = useMutation({ mutationFn: api.sync });
  const clear = useMutation({ mutationFn: api.clear });
  if (settings.data === undefined)
    return settings.error === null ? null : (
      <p className="error">{settings.error.message}</p>
    );
  const current = settings.data;
  const update = (change: Partial<Settings>) =>
    save.mutate({ ...current, ...change });
  const busy = activity.kind !== 'idle';
  const error = save.error ?? sync.error ?? clear.error;
  return (
    <>
      <EditableList
        label="Sites"
        type="url"
        placeholder="https://example.com/feed.xml"
        items={current.inputs}
        disabled={save.isPending}
        onChange={(inputs) => update({ inputs })}
      />
      <EditableList
        label="Include"
        type="text"
        placeholder="https://example.com/blog/*"
        items={current.include}
        disabled={save.isPending}
        onChange={(include) => update({ include })}
      />
      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={busy || current.inputs.length === 0}
          onClick={() => sync.mutate()}
        >
          Sync
        </button>
        <button
          type="button"
          className="quiet"
          disabled={busy || current.inputs.length === 0}
          onClick={() => clear.mutate()}
        >
          Clear
        </button>
      </div>
      {error !== null && <p className="error">{error.message}</p>}
      <ActivityLine activity={activity} />
    </>
  );
}

function ActivityLine({ activity }: { activity: Activity }) {
  if (activity.kind === 'idle') return null;
  if (activity.kind === 'clearing') return <p className="activity">Clearing</p>;
  const { progress } = activity;
  return (
    <dl className="activity">
      <dt>Syncing</dt>
      <dd>{progress?.status ?? 'starting'}</dd>
      <dt>Emitted</dt>
      <dd>
        {progress?.emitted.count ?? 0} · {progress?.emitted.deleted ?? 0}{' '}
        deleted
      </dd>
      <dt>Committed</dt>
      <dd>
        {progress?.committed.count ?? 0} · {progress?.committed.deleted ?? 0}{' '}
        deleted
      </dd>
    </dl>
  );
}
