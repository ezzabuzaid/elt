import type {
  InlineAttachment,
  Note,
  NoteAccount,
  NoteAttachment,
  NoteAttachmentReference,
  NoteDocument,
  NoteFolder,
  NoteStoreSnapshot,
} from '@eltjs/sdk-apple-notes';
import {
  type ImportScope,
  selected,
  withinDates,
} from '@eltjs/source-apple-macos/import-scope';

import { markdown, markdownTable, plainText } from './note-markdown.ts';

const noteLinkType = 'com.apple.notes.inlinetextattachment.link';

// Text that holds something: blank text loads as null.
export const string = (value: string | null) =>
  value !== null && value.trim() !== '' ? value : null;

// One run's read of the store: every stream reads through it. Accounts,
// folders, attachments and inline attachments are read once and kept, as
// lookups for the notes; notes are read as each stream iterates them, never
// held for the run: a store keeps tens of thousands. Disposing it ends the
// store's read transaction.
export class NotesScan implements AsyncDisposable {
  #accounts?: NoteAccount[];
  #folders?: NoteFolder[];
  #noteIds?: ReadonlySet<string | null>;
  #attachments?: NoteAttachment[];
  #inline?: InlineAttachment[];
  #attachmentsById?: Map<string | null, NoteAttachment>;
  #inlineById?: Map<string | null, InlineAttachment>;
  readonly #snapshot: NoteStoreSnapshot;
  readonly #scope: ImportScope;

  constructor(snapshot: NoteStoreSnapshot, scope: ImportScope = {}) {
    this.#snapshot = snapshot;
    this.#scope = scope;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.#snapshot[Symbol.dispose]();
  }

  // A folder scope keeps only the accounts that own a selected folder.
  get accounts(): NoteAccount[] {
    this.#accounts ??= this.#snapshot
      .accounts()
      .filter(
        (account) =>
          selected(this.#scope.accountIds, account.id) &&
          (this.#scope.collectionIds === undefined ||
            this.folders.some((folder) => folder.accountId === account.id)),
      );
    return this.#accounts;
  }

  get folders(): NoteFolder[] {
    this.#folders ??= this.#snapshot
      .folders()
      .filter(
        (folder) =>
          selected(this.#scope.accountIds, folder.accountId) &&
          selected(this.#scope.collectionIds, folder.id),
      );
    return this.#folders;
  }

  notes(): IteratorObject<Note, undefined> {
    return this.#snapshot
      .notes()
      .filter(
        (note) =>
          selected(this.#scope.accountIds, note.accountId) &&
          selected(this.#scope.collectionIds, note.folderId) &&
          withinDates(this.#scope, note.modifiedAt?.toISOString() ?? null),
      );
  }

  // Attachments and inline attachments of the notes in scope, one entry per
  // store row, in store order.
  get attachments(): readonly NoteAttachment[] {
    const notes = this.#notesInScope();
    this.#attachments ??= this.#snapshot
      .attachments()
      .filter((attachment) => notes.has(attachment.noteId))
      .toArray();
    return this.#attachments;
  }

  get inline(): readonly InlineAttachment[] {
    const notes = this.#notesInScope();
    this.#inline ??= this.#snapshot
      .inlineAttachments()
      .filter((inline) => notes.has(inline.noteId))
      .toArray();
    return this.#inline;
  }

  // Lookups by identifier, for a note's markdown and an attachment's file.
  attachment(id: string | null): NoteAttachment | undefined {
    this.#attachmentsById ??= new Map(
      this.attachments.map((attachment) => [attachment.id, attachment]),
    );
    return this.#attachmentsById.get(id);
  }

  #inlineAttachment(id: string | null): InlineAttachment | undefined {
    this.#inlineById ??= new Map(
      this.inline.map((inline) => [inline.id, inline]),
    );
    return this.#inlineById.get(id);
  }

  // Plain text keeps what reads as text: inline tags and mentions.
  text(document: NoteDocument): string {
    return plainText(
      document,
      ({ id }) => string(this.#inlineAttachment(id)?.altText ?? null) ?? '',
    );
  }

  markdown(document: NoteDocument): string {
    return markdown(document, ({ id, type }: NoteAttachmentReference) => {
      const token = this.#inlineAttachment(id);
      if (token !== undefined) {
        const text = token.altText ?? '';
        const target = string(token.target);
        // A link to another note points at its applenotes: URL.
        return token.type === noteLinkType && target !== null
          ? `[${text}](<${target}>)`
          : text;
      }
      const attachment = this.attachment(id);
      if (attachment === undefined) return '';
      const grid = attachment.table();
      if (grid !== null) return `\n${markdownTable(grid)}\n`;
      const label =
        string(attachment.title) ?? string(attachment.filename) ?? type ?? id;
      const url = string(attachment.url);
      return url === null
        ? `[${label}](attachment:${id})`
        : `[${label}](<${url}>)`;
    });
  }

  // The identifiers of the notes in scope, which keep their attachments.
  #notesInScope(): ReadonlySet<string | null> {
    this.#noteIds ??= new Set(this.notes().map((note) => note.id));
    return this.#noteIds;
  }
}
