# Office documents

A source has Word, PowerPoint, Excel, OpenDocument, PDF or RTF files, and a host wants their text in the warehouse. The office parser turns each file into plain text. The words that all of elt uses, for example document parser, file field and copy, are in the glossary of [elt](../../elt/CONTEXT.md).

## Language

**Office document**:
A file in one of the formats that the parser reads: `docx`, `pptx`, `xlsx`, `odt`, `odp`, `ods`, `pdf` or `rtf`. The extension of its name gives its format.
_Avoid_: Attachment (an attachment is a file of a source, in any format), Office file

**Text**:
The plain text that officeparser gives for a document: the paragraphs, the text of each slide, or the cells of each row.
_Avoid_: Content (content is the name of a field), Markdown

**Refused file**:
A file that officeparser does not read as its format: other content, a damaged file, or a document that a password locks. The parser gives `null` for it.
_Avoid_: Corrupt file (a refused file can be a correct file of another format), error
