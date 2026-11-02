// A profile's Bookmarks file that this process cannot read: it is missing,
// or the system denies it.
export class BookmarksUnavailableError extends Error {
  readonly path: string;

  constructor(path: string, options?: ErrorOptions) {
    super(
      `The bookmarks at ${JSON.stringify(path)} cannot be read: the file is missing, or this process has no access to it.`,
      options,
    );
    this.name = 'BookmarksUnavailableError';
    this.path = path;
  }
}

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
