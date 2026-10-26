import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { type Activity, activitySchema } from '../../src/contract.ts';

export function useActivity(): Activity {
  const queryClient = useQueryClient();
  const [activity, setActivity] = useState<Activity>({ kind: 'idle' });
  useEffect(() => {
    const events = new EventSource('/api/activity');
    events.onmessage = (event: MessageEvent<string>) => {
      setActivity(activitySchema.parse(JSON.parse(event.data)));
      for (const queryKey of [['articles'], ['history']])
        void queryClient.invalidateQueries(
          { queryKey },
          { cancelRefetch: false },
        );
    };
    return () => events.close();
  }, [queryClient]);
  return activity;
}
