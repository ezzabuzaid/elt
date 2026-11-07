// What a source keeps doing while a watch runs, beside the change signals
// that it declares: an action that the pipeline runs when the watch starts and
// then each interval, such as keeping an app running when only that app
// syncs its store (ADR 0021).
export type Upkeep = {
  // Milliseconds from the end of one run to the start of the next.
  readonly interval: number;
  // signal aborts when the watch stops.
  readonly run: (signal: AbortSignal) => Promise<void>;
};
