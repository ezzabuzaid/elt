import { WorkerKind } from '@zukhruf/pool';

/** A Vision read of one image: its absolute path. */
export interface VisionRead {
  readonly path: string;
}

/** The text that Vision found in the image, or null when it found none. */
export interface VisionText {
  readonly text: string | null;
}

// Every program on the computer sends its reads to one pool of Vision
// workers. Identical reads share one job. The time limit counts from the
// fetch, so it holds a cold warm-up, which VisionWorker kills after 10
// minutes, and a read, which it kills after 2; a read that fails runs once
// more, on a new worker when the first one exited.
export const visionKind = new WorkerKind<VisionRead, VisionText>({
  name: 'vision',
  revision: 1,
  policy: 'exclusive',
  retryLimit: 1,
  expireInSeconds: 15 * 60,
});
