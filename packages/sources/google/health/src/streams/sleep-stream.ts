import type { DataPoint } from '@workspace/sdk-google-health';

import { fields, session, sessionInstant } from '../health-fields.ts';
import { PointStream } from '../point-stream.ts';

export class SleepStream extends PointStream {
  constructor() {
    super({
      type: 'sleep',
      name: 'sleep',
      named: true,
      shared: true,
      description:
        "One record per sleep point Google Health holds for the user. A sleep session possibly including stages. Primary key name, the point's resource name. Reloaded whole on every run, so a point edited or deleted upstream is replaced or gone after the next run.",
      properties: {
        createTime: {
          ...fields.sessionInstant,
          description: 'Creation time of this sleep observation.',
        },
        ...session.properties,
        metadataExternalId: {
          ...fields.text,
          description:
            'Sleep identifier relevant in the context of the data source.',
        },
        metadataMainSleep: {
          ...fields.boolean,
          description:
            '`main_sleep`: the longest sleep session with stages within one day. If no sleep session has stages, then the longest sleep is the `main_sleep`. If there are multiple days of sleep in the response, there is one `main_sleep` per day.',
        },
        metadataManuallyEdited: {
          ...fields.boolean,
          description:
            'Some sleeps autodetected by algorithms can be manually edited by users.',
        },
        metadataNap: {
          ...fields.boolean,
          description:
            'Naps are sleeps without stages and relatively short durations.',
        },
        metadataProcessed: {
          ...fields.boolean,
          description:
            'Sleep and sleep stages algorithms finished processing. A `true` value indicates whether all data processing for the session is complete. A `false` value means sleep period is detected but sleep stages is still processing.',
        },
        metadataStagesStatus: {
          ...fields.text,
          description:
            'Sleep stages algorithm processing status. One of REJECTED_COVERAGE, REJECTED_MAX_GAP, REJECTED_START_GAP, REJECTED_END_GAP, REJECTED_NAP, REJECTED_SERVER, TIMEOUT, SUCCEEDED, PROCESSING_INTERNAL_ERROR.',
        },
        summaryMinutesAfterWakeUp: {
          ...fields.int64,
          description:
            'Minutes after wake up calculated by restlessness algorithm.',
        },
        summaryMinutesAsleep: {
          ...fields.int64,
          description:
            'Total number of minutes asleep. For classic sleep it is the sum of ASLEEP stages (excluding AWAKE and RESTLESS). For "stages" sleep it is the sum of LIGHT, REM and DEEP stages (excluding AWAKE).',
        },
        summaryMinutesAwake: {
          ...fields.int64,
          description:
            'Total number of minutes awake. It is a sum of all AWAKE stages.',
        },
        summaryMinutesInSleepPeriod: {
          ...fields.int64,
          description:
            'Delta between wake time and bedtime. It is the sum of all stages.',
        },
        summaryMinutesToFallAsleep: {
          ...fields.int64,
          description:
            'Minutes to fall asleep calculated by restlessness algorithm.',
        },
        type: {
          ...fields.text,
          description: 'SleepType: classic or stages. One of CLASSIC, STAGES.',
        },
        updateTime: {
          ...fields.sessionInstant,
          description: 'Last update time of this sleep observation.',
        },
      },
    });
  }

  protected row({ sleep }: DataPoint) {
    return {
      createTime: sessionInstant(sleep?.createTime),
      ...session.row(sleep?.interval),
      metadataExternalId: sleep?.metadata?.externalId ?? null,
      metadataMainSleep: sleep?.metadata?.mainSleep ?? null,
      metadataManuallyEdited: sleep?.metadata?.manuallyEdited ?? null,
      metadataNap: sleep?.metadata?.nap ?? null,
      metadataProcessed: sleep?.metadata?.processed ?? null,
      metadataStagesStatus: sleep?.metadata?.stagesStatus ?? null,
      summaryMinutesAfterWakeUp: sleep?.summary?.minutesAfterWakeUp ?? null,
      summaryMinutesAsleep: sleep?.summary?.minutesAsleep ?? null,
      summaryMinutesAwake: sleep?.summary?.minutesAwake ?? null,
      summaryMinutesInSleepPeriod: sleep?.summary?.minutesInSleepPeriod ?? null,
      summaryMinutesToFallAsleep: sleep?.summary?.minutesToFallAsleep ?? null,
      type: sleep?.type ?? null,
      updateTime: sessionInstant(sleep?.updateTime),
    };
  }
}
