// A Bookmarks file that is not the JSON Chromium's BookmarkCodec writes.
export class BookmarksFormatError extends Error {
  readonly path: string;

  constructor(path: string, reason: string, options?: ErrorOptions) {
    super(
      `${JSON.stringify(path)} is not a Chromium Bookmarks file: ${reason}.`,
      options,
    );
    this.name = 'BookmarksFormatError';
    this.path = path;
  }
}
