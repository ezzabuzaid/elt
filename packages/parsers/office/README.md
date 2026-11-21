# @eltjs/parser-office

`OfficeDocumentParser` is a `DocumentParser` of [elt](../../elt/README.md#write-a-document-parser). It gives the plain text of Office documents and PDF files. It uses [officeparser](https://github.com/harshankur/officeParser) 8, which is JavaScript only and needs no installed application. Thus it runs on Linux, macOS and Windows.

## Use

Store the documents, and let a `DocumentText` [computed dataset](../../destinations/sqlite/README.md#declare-a-computed-dataset) give their text. Then a document that the parser cannot read is a row with its error, and it fails no copy:

```ts
import { DocumentText, LocalFiles } from '@eltjs/elt';
import { ComputedDataset } from '@eltjs/elt-sqlite';
import { OfficeDocumentParser } from '@eltjs/parser-office/office-document-parser';

const parser = new OfficeDocumentParser();
const files = new LocalFiles({ directory: 'warehouse/files' });

const documents = sqlite.table('files', (c) => [
  c.text('id'),
  // Only the files that the parser accepts are downloaded and stored.
  c.text('documentRef').from(stream.file.accepting(parser).store(files)),
]);

const text = new ComputedDataset({
  into: sqlite,
  name: 'document_text',
  description: 'The text of each stored document.',
  from: [documents],
  compute: new DocumentText({
    parser: () => parser,
    files,
    column: 'documentRef',
  }),
});
```

A copy can also parse at load time, with `c.text('content').from(stream.file).parse(parser)`. Then a document that the parser cannot read fails the copy, because the parser throws.

## Formats

| Extension              | Format                                          |
| ---------------------- | ----------------------------------------------- |
| `docx`, `pptx`, `xlsx` | Word, PowerPoint and Excel (Office Open XML)    |
| `odt`, `odp`, `ods`    | OpenDocument text, presentation and spreadsheet |
| `pdf`                  | PDF                                             |
| `rtf`                  | Rich Text Format                                |

- `accepts(fileName)` is `true` only when the extension of the name is in this table, in any case. Thus `Proposal.DOCX` is accepted and `team photo.jpg` is not. A source can skip the download of a file that the parser does not read.
- The extension selects the format. The parser does not find the format from the content.
- The text of a slide deck has the text of each slide. The text of a spreadsheet has one line for each row, with a tab between the cells.
- The parser does not read the text in images. OCR stays off.

## Results

- `parse(path, signal?)` returns the text of the document.
- It returns `null` when the extension is not in the table, without a read of the file, and when the document has no text.
- It throws when:
  - the file cannot be read, for example when it does not exist or the process has no permission;
  - the content is not the format of the extension, for example a JPEG photo named `x.docx`, or a file that is cut off or damaged. The message names the code of officeparser, such as `FILE_CORRUPTED`;
  - a password locks the document (`PASSWORD_REQUIRED`);
  - officeparser stops at one of its limits (a code that ends in `_LIMIT_EXCEEDED`), because the document has text that the parser did not read.
- Thus the `DocumentText` dataset records `empty` only for a document with no text, and an error with the reason for each other document that gives no text.
- An aborted `signal` rejects the parse with an `AbortError`.
- The identity is `office-document:officeparser@8`. A new major version of officeparser gives a new identity.

## Precedent

Airbyte's [unstructured parser](https://github.com/airbytehq/airbyte-python-cdk/blob/f77450f74def59598cda8e1e9a4e975031710c18/airbyte_cdk/sources/file_based/file_types/unstructured_parser.py) turns `docx`, `pptx` and `pdf` files into text in the file-based sources. This parser does the same job, but it gives plain text, not Markdown.
