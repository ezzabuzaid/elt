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

`MacOSDocumentParser` selects a format by the file extension, or by the leading bytes if the extension does not identify the file. Add `ImageFormat` and `AudioFormat` as more formats. Without `ImageFormat`, images parse to null. Without `AudioFormat`, audio parses to null.

`parse()` returns null for a file that matches no format, a locked PDF, a PDF without a text layer and an image without text. It throws when it cannot read a file. The identity of the parser includes its formats, and `identityFor(path)` gives the format that reads a file.

The host owns the workers. It builds a `Pool` from `@zukhruf/pool` for each kind of worker, and disposes the pool to stop the workers. Use `LeaderFirst` for Vision: the first worker compiles the Vision models and caches them, and the other workers then read that cache.

## Limitations

- The parser runs only on macOS. It uses PDFKit, `textutil`, `osascript` and Vision.
- Images narrower or shorter than three pixels parse to null.
- A Vision read stops after 120 seconds. PDF text goes through `osascript`, with a 64 MiB output limit and a 120-second timeout. Text conversion has the default `execFile` output limit of 1 MiB and no timeout.

See [docs/reference.md](../../../../docs/reference.md#attachment-files-and-document-parsing) for the details.
