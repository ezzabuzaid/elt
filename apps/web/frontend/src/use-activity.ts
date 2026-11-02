import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { type Activity, activitySchema } from '../../src/contract.ts';

// The last Sync, live. The articles reload when the run writes records or
// ends, and the history when a run starts or ends, not on each request.
export function useActivity(): Activity {
  const queryClient = useQueryClient();
  const [activity, setActivity] = useState<Activity>(null);
  useEffect(() => {
    const events = new EventSource('/api/activity');
    let previous: Activity = null;
    const invalidate = (key: string) => {
      void queryClient.invalidateQueries(
        { queryKey: [key] },
        { cancelRefetch: false },
      );
    };
    events.onmessage = (event: MessageEvent<string>) => {
      const next = activitySchema.parse(JSON.parse(event.data));
      const began = next?.startedAt !== previous?.startedAt;
      const ended = next?.ended?.at !== previous?.ended?.at;
      const written = next?.written !== previous?.written;
      previous = next;
      setActivity(next);
      if (written || ended) {
        invalidate('articles');
      }
      if (began || ended) {
        invalidate('history');
      }
    };
    return () => events.close();
  }, [queryClient]);
  return activity;
}
