import type { Clock } from '@zukhruf/async';

// The time and the timers of a pipeline. The caller gives it: an app gives
// globalThis, and a test gives a fake clock that it moves. The pipeline gives
// it to its sources and its destination on each call, so one pipeline runs on
// one clock (ADR 0019).
export type PipelineClock = Clock & { readonly Date: { now(): number } };
