# @workspace/transcription-local

A local transcription model for the AI SDK. `LocalTranscriptionModel` implements `TranscriptionModelV4` over a native worker that runs [transcribe.cpp](https://github.com/handy-computer/transcribe.cpp). The worker loads a GGUF model and runs it on Metal. Give the model to `AudioFormat` of [source-apple-macos](../sources/apple/macos/README.md#parsing), or call it directly.

```ts
import { readFile } from 'node:fs/promises';

import { Fixed, Parallel, Pool } from '@zukhruf/pool';
import { transcribe } from 'ai';

import { LocalTranscriptionModel } from '@workspace/transcription-local';
import { TranscriptionWorker } from '@workspace/transcription-local/transcription-worker';

const configuration = {
  name: 'cohere-transcribe-arabic-07-2026',
  path: '/path/to/cohere-transcribe-arabic-07-2026-Q8_0.gguf',
  language: 'ar',
};
await using engines = new Pool({
  size: new Fixed(1),
  startup: new Parallel(),
  create: () =>
    new TranscriptionWorker('/path/to/transcribe-local', configuration),
});
const { text } = await transcribe({
  model: new LocalTranscriptionModel(configuration, engines),
  audio: await readFile('/path/to/voice-message.opus'),
});
```

## How it transcribes

- The model converts the input with `afconvert` of macOS to 16 kHz mono 32-bit float samples. Thus a Mac needs nothing installed.
- It then borrows an engine from its pool. An engine keeps the weights loaded across calls, and transcribes one file at a time. The host owns the pool and disposes it.
- `TranscriptionWorker.check(helper)` checks that the engine runs on this Mac, and loads no weights.
- Cohere decodes at most 512 tokens in one run. Thus audio longer than 40 s is cut at pauses that Silero VAD finds, into pieces of about 30 s, and the engine decodes each piece by itself. The Silero model is part of the worker.
- The transcript has no segments, because Cohere marks no timings.
- A cancel stops the decode or the inference.
- `language`, when you give it, tells the model the language of the speech. The model id holds it, so a new language reads the audio again.
- The model id is the name and the language. The path only tells where the file is on this Mac, so a store that moves to a different Mac keeps its transcripts.

To find the models that are installed on the Mac, use [sdk-macos-speech-models](../sdks/macos/speech-models/README.md).

## Development

```sh
npx nx run transcription-local:test     # builds the native worker and the package, then runs the tests
npx nx run transcription-local:helper   # builds dist/transcribe-local from native/
```
