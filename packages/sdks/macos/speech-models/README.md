# @workspace/sdk-macos-speech-models

Lists the speech models installed on this Mac, whichever app or tool installed them. Each model gives the configuration of a [local transcription model](../../../transcription-local/README.md).

```ts
import { SpeechModels } from '@workspace/sdk-macos-speech-models';

const models = await new SpeechModels().list(); // [{ id, title, configuration }, ...]
```

## Where it looks

- The Hugging Face cache (`~/.cache/huggingface/hub`), where `hf`, Handy and other tools download.
- Each `.gguf` or `.bin` file that Spotlight finds in the home folder. Spotlight does not index `~/.cache`.

## What counts as a speech model

- A GGUF counts when its architecture is one that the catalog of Handy (`@handy-computer/models`) lists for transcription.
- A `.bin` file counts when it is a whisper.cpp model.
- The id of a model is its file name. When a file is in several places, the copy in the Hugging Face cache comes first.
- The title is the name in the catalog, else the name in the GGUF, else the file name.
- Only Cohere Transcribe Arabic gets a language: Arabic. Told Arabic, it also writes English as spoken.
- The SDK never downloads or changes a model.

## Development

```sh
npx nx run sdk-macos-speech-models:test
```
