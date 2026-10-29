# @workspace/source-apple-macos

The shared macOS kit of the Apple sources. It is not the source of one app. It gives the document parser that turns stored files into text, the native Vision worker for text recognition in images, the import scope type, and other parts that several Apple sources use. Sources use the scope and schema parts. Hosts build the parser and the worker pools.

```ts
import { fileURLToPath } from 'node:url';

import { HillClimbing, LeaderFirst, Pool } from '@zukhruf/pool';

import { ImageFormat } from '@workspace/source-apple-macos/image-format';
import { MacOSDocumentParser } from '@workspace/source-apple-macos/macos-document-parser';
import { VisionWorker } from '@workspace/source-apple-macos/vision';

await using ocr = new Pool({
  size: new HillClimbing({ memoryPerWorker: VisionWorker.memory }),
  startup: new LeaderFirst(),
  create: () =>
    new VisionWorker(
      fileURLToPath(
        import.meta.resolve('@workspace/source-apple-macos/vision-worker'),
      ),
    ),
});
const parser = new MacOSDocumentParser([new ImageFormat(ocr)]);

const text = await parser.parse('./receipt.png'); // string, or null
```

Give the parser to a `DocumentText` rule to read the text of the files that a pipeline stores. The [Notes README](../notes/README.md) shows this.

## Exports

| Subpath                        | Export                                   | Use                                                                                                                                          |
| ------------------------------ | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `./macos-document-parser`      | `MacOSDocumentParser`                    | A `DocumentParser`. It reads PDFs with PDFKit, text documents with `textutil` (TXT, Markdown, RTF, HTML, DOC, DOCX, ODT, WordML) and vCards. |
| `./image-format`               | `ImageFormat`                            | A format that reads text in images through a `Pool` of `VisionWorker`s.                                                                      |
| `./audio-format`               | `AudioFormat`                            | A format that transcribes audio with an AI SDK transcription model that the caller gives.                                                    |
| `./document-format`            | `DocumentFormat`                         | The base class of a format. Extend it to add a format to `MacOSDocumentParser`.                                                              |
| `./file-head`                  | `FileHead`                               | The first bytes of a file, which a format uses to identify the file.                                                                         |
| `./vision`                     | `VisionWorker`                           | One native Vision process. `VisionWorker.memory` is the memory to size a pool by.                                                            |
| `./vision-worker`              | the compiled helper                      | The native Vision binary. The `helper` target builds it from `src/helper/main.swift`.                                                        |
| `./import-scope`               | `ImportScope`, `selected`, `withinDates` | The scope of an import: `accountIds`, `collectionIds`, `startAt` (inclusive) and `endAt` (exclusive). An absent key means all.               |
| `./local-apple-store-coverage` | `localAppleStoreCoverage`                | The extraction coverage of a source that reads its full local store.                                                                         |
| `./eventkit-fields`            | `eventKitFields`                         | JSON Schema primitives that several Apple sources share.                                                                                     |
| `./osa`                        | `OSA`, and a default instance            | Runs a JavaScript for Automation script through `/usr/bin/osascript`.                                                                        |

## Parsing

`MacOSDocumentParser` is a `DocumentParser` of elt (see [write a document parser](../../../elt/README.md#write-a-document-parser)). Its built-in formats are:

- PDFs with a text layer, through native PDFKit.
- TXT, Markdown, RTF, HTML, DOC, DOCX, ODT and WordML, through native `textutil`. Text and Markdown keep their content. The other formats lose their rich formats when they become plain text. An HTML conversion does not load external resources.
- vCards, also the `.loc.vcf` locations of Messages, which load as their text.

`new MacOSDocumentParser([...formats])` adds `DocumentFormat` instances, and keeps the built-in formats:

- `ImageFormat(ocr)` reads images (JPEG, PNG, GIF, HEIC/HEIF, TIFF, BMP, ICO, WebP) through the accurate text recognition of Vision, one line for each observation. ImageIO checks the dimensions first. An image narrower or shorter than three pixels returns null, because Vision crashes on such inputs or refuses them. Without `ImageFormat`, images parse to null.
- `AudioFormat(model)` transcribes audio with `transcribe()` of the Vercel AI SDK and a transcription model that the caller owns. It owns no credentials and no model lifetime. Without `AudioFormat`, audio parses to null.

Rules:

- A format claims a file by its extension, or by its magic number, the leading bytes that name the format. Thus a file with no usable extension, such as the `GroupPhotoImage` of Messages, is still read. Text that only starts like a magic number, such as `BMW` or `%PDF notes`, is not taken for an image or a PDF.
- A file that matches no format, a locked PDF, a PDF with no text layer, and an image with no text that Vision can find parse to `null`. The field then loads as null, and the copy continues.
- A file that the parser cannot read (a PDF that does not open, an image that Vision cannot decode, an error of `textutil`) fails the copy.
- The identity of the parser includes its formats and their configuration. Each format has its own identity, so a new audio model does not invalidate the text of PDFs, images or documents. `identityFor(path)` gives the format, and the model, that reads one file.
- The caller composes the parser, with or without `AudioFormat`. [Context Compiler](https://github.com/ezzabuzaid/context-compiler/blob/main/docs/connectors-and-hosts.md) composes it from the transcription that the user saved.

A parser with local Vision and local transcription:

```ts
import {
  Fixed,
  HillClimbing,
  LeaderFirst,
  Parallel,
  Pool,
} from '@zukhruf/pool';

import { AudioFormat } from '@workspace/source-apple-macos/audio-format';
import { ImageFormat } from '@workspace/source-apple-macos/image-format';
import { MacOSDocumentParser } from '@workspace/source-apple-macos/macos-document-parser';
import { VisionWorker } from '@workspace/source-apple-macos/vision';
import { LocalTranscriptionModel } from '@workspace/transcription-local';
import { TranscriptionWorker } from '@workspace/transcription-local/transcription-worker';

const configuration = {
  name: 'cohere-transcribe-arabic-07-2026',
  path: '/path/to/cohere-transcribe-arabic-07-2026-Q8_0.gguf',
  language: 'ar',
};
await using ocr = new Pool({
  size: new HillClimbing({ memoryPerWorker: VisionWorker.memory }),
  startup: new LeaderFirst(),
  create: () => new VisionWorker('/path/to/vision-worker'),
});
await using engines = new Pool({
  size: new Fixed(1),
  startup: new Parallel(),
  create: () =>
    new TranscriptionWorker('/path/to/transcribe-local', configuration),
});
const parser = new MacOSDocumentParser([
  new ImageFormat(ocr),
  new AudioFormat(new LocalTranscriptionModel(configuration, engines)),
]);
const text = await parser.parse('/path/to/voice-message.opus');
```

`@workspace/transcription-local` is the local transcription model, which also works directly with `transcribe({ model, audio })` of the AI SDK. See its [README](../../../transcription-local/README.md).

## Worker pools

The host owns the native workers. It builds a `Pool` of `@zukhruf/pool` for each kind of worker, and it disposes the pool, which stops each worker.

- A pool lends one worker to one read at a time, and replaces a worker that stopped.
- The startup decides when the workers start. `LeaderFirst` starts the first Vision worker alone, because Vision compiles its models one time for each helper binary and caches them, and the other workers read that cache. `Parallel`, `OrderedReady` and `OnDemand` are the other startups.
- The sizing decides how many workers run:
  - `Fixed(n)` runs n workers.
  - `Resources({ memoryPerWorker })` runs one worker for each CPU while each finds its memory free.
  - `HillClimbing` starts with two, and adds one while the last one added gave at least a tenth more jobs each second, as the thread pool of .NET does.
  - `Gradient` starts with two, and adds one while a job takes at most half again the best time, as `concurrency-limits` of Netflix does.
- The two sizings that learn measure only while jobs wait and each worker is ready, in windows of at least 20 jobs and 2 seconds. Each step measures the size until then, one more, and the size until then again, and compares one more with the mean of the two. Thus work that changes while it is measured, for example files that come grouped by kind, does not decide. The worker that a step tries stays alive between the measures. They learn one time for each pool, and never go past the capacity of the Mac.
- `VisionWorker.memory` is the memory by which to size a Vision pool.

## Coverage

`localAppleStoreCoverage` is the [coverage](../../../elt/README.md#coverage) of each Apple source except Calendar and Activity: each record that the stream can export from the local Apple store that the process can read, with no date filter. Local availability, permissions and what the source leaves out still limit the export. It does not promise the full cloud history. The metadata of an attachment can exist with no bytes that the source can get. Its `selection` is empty. A source with an import scope gives that scope as the selection.

## Limitations

- The parser runs only on macOS. It uses PDFKit, `textutil`, `osascript` and Vision.
- Images narrower or shorter than three pixels parse to null.
- A Vision read stops after 120 seconds. PDF text goes through `osascript`, with a 64 MiB output limit and a 120-second timeout. Text conversion has the default `execFile` output limit of 1 MiB and no timeout.
