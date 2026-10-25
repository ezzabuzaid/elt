// A long-lived resource the pool lends to one job at a time, such as a native
// process that keeps a model loaded. ready settles when it can take jobs; a
// worker without a warm-up omits it.
export interface Worker {
  readonly ready?: Promise<unknown>;
  readonly dead: boolean;
  kill(): void;
  close(): Promise<void>;
}
