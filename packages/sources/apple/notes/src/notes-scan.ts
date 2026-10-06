import type {
  InlineAttachment,
  Note,
  NoteAccount,
  NoteAttachment,
  NoteAttachmentReference,
  NoteDocument,
  NoteFolder,
  NoteStoreSnapshot,
} from '@workspace/sdk-apple-notes';
import {
  type ImportScope,
  selected,
  withinDates,
} from '@workspace/source-apple-macos/import-scope';

import { markdown, markdownTable, plainText } from './note-markdown.ts';

const noteLinkType = 'com.apple.notes.inlinetextattachment.link';

// Text that holds something: blank text loads as null.
export const string = (value: string | null) =>
  value !== null && value.trim() !== '' ? value : null;

// One run's read of the store: every stream reads through it and each kind
// of object is read once. Disposing it ends the store's read transaction.
export class NotesScan implements AsyncDisposable {
  #accounts?: NoteAccount[];
  #folders?: NoteFolder[];
  #notes?: Note[];
  #attachments?: Map<string | null, NoteAttachment>;
  #inline?: Map<string | null, InlineAttachment>;
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

  get notes(): Note[] {
    this.#notes ??= this.#snapshot
      .notes()
      .filter(
        (note) =>
          selected(this.#scope.accountIds, note.accountId) &&
          selected(this.#scope.collectionIds, note.folderId) &&
          withinDates(this.#scope, note.modifiedAt?.toISOString() ?? null),
      );
    return this.#notes;
  }

  // Attachments and inline attachments of the notes in scope, by identifier,
  // in store order. An attachment the store lists once per location keeps
  // one entry.
  get attachments(): ReadonlyMap<string | null, NoteAttachment> {
    if (this.#attachments !== undefined) return this.#attachments;
    const notes = new Set(this.notes.map((note) => note.id));
    this.#attachments = new Map(
      this.#snapshot
        .attachments()
        .filter((attachment) => notes.has(attachment.noteId))
        .map((attachment) => [attachment.id, attachment]),
    );
    return this.#attachments;
  }

  get inline(): ReadonlyMap<string | null, InlineAttachment> {
    if (this.#inline !== undefined) return this.#inline;
    const notes = new Set(this.notes.map((note) => note.id));
    this.#inline = new Map(
      this.#snapshot
        .inlineAttachments()
        .filter((inline) => notes.has(inline.noteId))
        .map((inline) => [inline.id, inline]),
    );
    return this.#inline;
  }

  // Plain text keeps what reads as text: inline tags and mentions.
  text(document: NoteDocument): string {
    return plainText(
      document,
      ({ id }) => string(this.inline.get(id)?.altText ?? null) ?? '',
    );
  }

  markdown(document: NoteDocument): string {
    return markdown(document, ({ id, type }: NoteAttachmentReference) => {
      const token = this.inline.get(id);
      if (token !== undefined) {
        const text = token.altText ?? '';
        const target = string(token.target);
        // A link to another note points at its applenotes: URL.
        return token.type === noteLinkType && target !== null
          ? `[${text}](<${target}>)`
          : text;
      }
      const attachment = this.attachments.get(id);
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
}
