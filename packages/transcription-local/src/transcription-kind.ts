import { hash } from 'node:crypto';

import { WorkerKind } from '@zukhruf/pool';

import type { LocalTranscriptionConfiguration } from './local-transcription-model.ts';

/** A transcription of one 16 kHz mono WAVE file: its absolute path. */
export interface TranscriptionRead {
  readonly path: string;
}

/** The text of the speech in the file. */
export interface Transcript {
  readonly text: string;
}

// Each model is a kind of its own: a worker loads the weights of one model, so
// the programs that chose the same model share its workers, and a program that
// chose another model never runs on them. The name holds a hash of the model's
// name and language, which say what the model is; its path only says where its
// file is on this Mac. A job runs at most an hour, for a long recording.
export function transcriptionKind({
  name,
  language,
}: LocalTranscriptionConfiguration): WorkerKind<TranscriptionRead, Transcript> {
  const model = hash('sha256', JSON.stringify({ name, language }), 'hex');
  return new WorkerKind({
    name: `transcription-${model.slice(0, 16)}`,
    revision: 1,
    policy: 'standard',
    retryLimit: 0,
    expireInSeconds: 60 * 60,
  });
}
